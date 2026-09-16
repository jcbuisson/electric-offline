import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { prepareLocalDB } from '../frontend/localSchema.js'
import { prepareDirectoryLocal } from '../frontend/directorySchema.js'
import { prepareDirectoryServer } from '../backend/directorySchema.js'
import { applyDirectoryMutation } from '../backend/directoryMutations.js'
import { createDirectorySync } from '../frontend/directorySync.js'
import { membershipId } from '../shared/directoryModels.js'

const local = new PGlite(), remote = new PGlite()
const network = { onLine: true }
let sync, sent, failTable
const user = { firstname: 'Alice', lastname: 'Example', email: 'alice@example.com' }
const group = { name: 'Editors' }
before(async () => {
   await prepareLocalDB(local); await prepareDirectoryLocal(local); await prepareDirectoryLocal(local)
   await prepareDirectoryServer({ query: sql => remote.exec(sql) }); await prepareDirectoryServer({ query: sql => remote.exec(sql) })
})
after(async () => { await local.close(); await remote.close() })
beforeEach(async () => {
   await local.exec('TRUNCATE app_user, app_group, user_group_relation, mutation_queue')
   await remote.exec('TRUNCATE user_group_relation, app_user, app_group, directory_mutation_cursor CASCADE')
   network.onLine = true; sent = []; failTable = null
   sync = createDirectorySync(local, { network, fetchRequest: async (url, options) => {
      const [, , , table, id] = url.split('/')
      sent.push({ table, method: options.method })
      if (table === failTable) return new Response(JSON.stringify({ error: 'Duplicate email' }), { status: 409 })
      const row = await remote.transaction(tx => applyDirectoryMutation(tx, { table, id,
         clientId: options.headers['X-Sync-Client'], revision: options.headers['X-Mutation-Revision'],
         action: options.method === 'POST' ? 'create' : options.method === 'PUT' ? 'update' : 'delete',
         values: options.body && JSON.parse(options.body),
      }))
      return new Response(JSON.stringify(row), { headers: { 'X-Sync-Version': String(row.version) } })
   } })
})
async function snapshot(table) { await sync.applySnapshot(table, (await remote.query(`SELECT * FROM ${table}`)).rows) }
async function snapshotAll() { for (const table of ['app_user','app_group','user_group_relation']) await snapshot(table) }

test('offline parents and memberships upload in dependency order and await Electric', async () => {
   network.onLine = false
   const userId = await sync.save('app_user', null, user)
   const groupId = await sync.save('app_group', null, group)
   await sync.setMembership(userId, groupId, true)
   await sync.flushQueue(); assert.equal(sent.length, 0)
   assert.equal((await sync.read()).memberships.length, 1)
   network.onLine = true; await sync.flushQueue()
   assert.deepEqual(sent.map(m => m.table), ['app_user','app_group','user_group_relation'])
   assert.equal((await sync.read()).mutations.length, 3)
   await sync.applySnapshot('app_user', [])
   assert.equal((await sync.read()).users.length, 1, 'lagging empty snapshot preserves pending user')
   await snapshotAll(); assert.equal((await sync.read()).mutations.length, 0)
})

test('membership identity is shared by clients and supports remove/re-add', async () => {
   const userId = await sync.save('app_user', null, user), groupId = await sync.save('app_group', null, group)
   await sync.setMembership(userId, groupId, true); await sync.flushQueue(); await snapshotAll()
   const id = await membershipId(userId, groupId)
   await remote.transaction(tx => applyDirectoryMutation(tx, { clientId: crypto.randomUUID(), revision: '1',
      table: 'user_group_relation', id, action: 'update', values: { user_uid: userId, group_uid: groupId } }))
   assert.equal((await remote.query('SELECT * FROM user_group_relation')).rows.length, 1)
   await sync.setMembership(userId, groupId, false); await sync.flushQueue(); await snapshotAll()
   assert.equal((await sync.read()).memberships.length, 0)
   await sync.setMembership(userId, groupId, true); await sync.flushQueue(); await snapshotAll()
   assert.equal((await sync.read()).memberships.length, 1)
   assert.equal((await sync.read()).mutations.length, 0)
})

test('deleting a parent cascades versioned tombstones and hides memberships locally', async () => {
   const uid = await sync.save('app_user', null, user), gid = await sync.save('app_group', null, group)
   await sync.setMembership(uid, gid, true); await sync.flushQueue(); await snapshotAll()
   await sync.remove('app_group', gid)
   assert.equal((await sync.read()).memberships.length, 0)
   await sync.flushQueue(); await snapshotAll()
   assert.equal((await sync.read()).mutations.length, 0)
   assert.equal((await remote.query('SELECT deleted FROM user_group_relation')).rows[0].deleted, true)
})

test('another client deleting a parent prevents a late membership from resurrecting it', async () => {
   const uid = await sync.save('app_user', null, user), gid = await sync.save('app_group', null, group)
   await sync.flushQueue(); await snapshotAll()
   await sync.setMembership(uid, gid, true)
   await remote.transaction(tx => applyDirectoryMutation(tx, { clientId: crypto.randomUUID(), revision: '1',
      table: 'app_user', id: uid, action: 'delete' }))
   await sync.flushQueue(); await snapshotAll()
   assert.equal((await sync.read()).memberships.length, 0)
   assert.equal((await sync.read()).mutations.length, 0)
})

test('failed parents block memberships until corrected, without blocking unrelated groups', async () => {
   const uid = await sync.save('app_user', null, user), gid = await sync.save('app_group', null, group)
   await sync.setMembership(uid, gid, true)
   failTable = 'app_user'; await sync.flushQueue()
   assert.deepEqual(sent.map(m => m.table), ['app_user','app_group'])
   assert.equal((await sync.read()).mutations.filter(m => m.status === 'failed').length, 1)
   failTable = null; await sync.save('app_user', uid, { ...user, email: 'other@example.com' })
   await sync.flushQueue(); await snapshotAll()
   assert.equal((await sync.read()).mutations.length, 0)
})

test('server receipts reject delayed older writes and preserve the saved result on retry', async () => {
   const clientId = crypto.randomUUID(), id = crypto.randomUUID()
   const mutate = (revision, action, values) => remote.transaction(tx => applyDirectoryMutation(tx,
      { clientId, revision, action, values, id, table: 'app_user' }))
   await mutate('1', 'create', user)
   const latest = await mutate('3', 'update', { ...user, firstname: 'Newest' })
   assert.deepEqual(await mutate('2', 'update', user), latest)
   assert.deepEqual(await mutate('3', 'update', user), latest)
   assert.equal((await remote.query('SELECT firstname FROM app_user')).rows[0].firstname, 'Newest')
})

test('emails and group names are unique among active records and reusable after deletion', async () => {
   const id = crypto.randomUUID(), clientId = crypto.randomUUID()
   const mutation = { clientId, revision: '1', id, table: 'app_user', action: 'create', values: user }
   await remote.transaction(tx => applyDirectoryMutation(tx, mutation))
   await assert.rejects(remote.transaction(tx => applyDirectoryMutation(tx, { ...mutation, id: crypto.randomUUID() })), { code: '23505' })
   await remote.transaction(tx => applyDirectoryMutation(tx, { ...mutation, revision: '2', action: 'delete' }))
   await remote.transaction(tx => applyDirectoryMutation(tx, { ...mutation, id: crypto.randomUUID() }))
   assert.equal((await remote.query('SELECT * FROM app_user WHERE NOT deleted')).rows.length, 1)
})
