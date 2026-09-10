import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { PGlite } from '@electric-sql/pglite'
import { createSnapshotSync } from '../frontend/snapshotSync.js'
import { createTodoSync } from '../frontend/todoSync.js'

const id = '11111111-1111-4111-8111-111111111111'
const todo = (label = 'local') => ({ id, label, completed: false })
const remote = (label = 'local', version = '200', deleted = false) => ({ ...todo(label), version, deleted })
const db = new PGlite()
let sync, app, fetchHandler

before(async () => {
   // Run the actual schema initializer against an isolated in-memory database.
   const source = await readFile(new URL('../frontend/createLocalDB.js', import.meta.url), 'utf8')
   const schema = vm.createContext({ db })
   vm.runInContext(source.slice(source.indexOf('export async')).replace('export ', ''), schema)
   await schema.prepareLocalDB()
   await schema.prepareLocalDB() // Existing databases must also migrate safely.
})
after(() => db.close())
beforeEach(async () => {
   await db.exec('TRUNCATE todo, mutation_queue RESTART IDENTITY')
   sync = createSnapshotSync(db)
   app = createTodoSync(db, {
      snapshotSync: sync,
      fetchRequest: (...args) => fetchHandler(...args),
      network: { onLine: true },
   })
   fetchHandler = async () => new Response(JSON.stringify(todo()), {
      status: 200, headers: { 'X-Sync-Version': '200' },
   })
})

async function seed(action = 'update') {
   if (action !== 'delete') await db.query('INSERT INTO todo VALUES ($1, $2, false)', [id, 'local'])
   await db.query(`INSERT INTO mutation_queue (table_name, action, row_id, payload)
      VALUES ('todo', $1, $2, $3)`, [action, id, action === 'delete' ? null : JSON.stringify(todo())])
   return (await queue())[0]
}
const queue = async () => (await db.query('SELECT * FROM mutation_queue')).rows
const rows = async () => (await db.query('SELECT * FROM todo')).rows

for (const action of ['create', 'update', 'delete']) {
   test(`${action}: HTTP acknowledgement protects against lagging snapshots until Electric catches up`, async () => {
      await seed(action)
      if (action === 'delete') fetchHandler = async () => new Response(null, {
         status: 204, headers: { 'X-Sync-Version': '200' },
      })
      await app.flushQueue()
      assert.equal((await queue())[0].acknowledged_version, '200')
      assert.equal((await db.query("SELECT * FROM mutation_queue WHERE status = 'pending' AND acknowledged_version IS NULL")).rows.length, 0)
      await sync.apply(action === 'create' ? [] : [remote('old', '100')])
      assert.deepEqual(await rows(), action === 'delete' ? [] : [todo()])
      assert.equal((await queue()).length, 1)
      await sync.apply([remote('local', '200', action === 'delete')])
      assert.deepEqual(await rows(), action === 'delete' ? [] : [todo()])
      assert.equal((await queue()).length, 0)
   })
}

test('Electric arriving before HTTP acknowledgement is reconciled immediately afterwards', async () => {
   await seed()
   await sync.apply([remote('newer remote edit', '300')])
   assert.deepEqual(await rows(), [todo()])
   await app.flushQueue()
   assert.deepEqual(await rows(), [todo('newer remote edit')])
   assert.equal((await queue()).length, 0)
})

test('acknowledgement survives a client restart and stale initial snapshot', async () => {
   await seed('create')
   await app.flushQueue()
   const restarted = createSnapshotSync(db)
   await restarted.apply([])
   assert.deepEqual(await rows(), [todo()])
   await restarted.apply([remote()])
   assert.equal((await queue()).length, 0)
})

test('editing an acknowledged create queues an update and invalidates the old acknowledgement', async () => {
   await seed('create')
   await app.flushQueue()
   await app.editTodo(id, 'edited again', true)
   const [mutation] = await queue()
   assert.equal(mutation.action, 'update')
   assert.equal(mutation.acknowledged_version, null)
   await sync.apply([remote('local', '300')])
   assert.equal((await rows())[0].label, 'edited again')
   assert.equal((await queue()).length, 1)
})

test('deleting an acknowledged create remains protected from its incoming insert', async () => {
   await seed('create')
   await app.flushQueue()
   await app.deleteTodo(id)
   await sync.apply([remote('local', '300')])
   assert.deepEqual(await rows(), [])
   assert.equal((await queue())[0].action, 'delete')
   assert.equal((await queue())[0].acknowledged_version, null)
})

test('editing during an in-flight request does not acknowledge the newer edit', async () => {
   await seed()
   let requests = 0
   fetchHandler = async () => {
      // Leave the newer edit unsent after the first request finishes.
      if (++requests > 1) throw new Error('Connection lost')
      await app.editTodo(id, 'edited in flight', true)
      return new Response(JSON.stringify(todo()), { headers: { 'X-Sync-Version': '200' } })
   }
   await app.flushQueue()
   await sync.apply([remote('local', '300')])
   assert.equal((await rows())[0].label, 'edited in flight')
   assert.equal((await queue())[0].acknowledged_version, null)
})

test('404 acknowledgement protects absence until Electric reaches the acknowledged version', async () => {
   await seed()
   fetchHandler = async () => new Response(null, { status: 404, headers: { 'X-Sync-Version': '200' } })
   await app.flushQueue()
   await sync.apply([remote('old', '100')])
   assert.deepEqual(await rows(), [])
   assert.equal((await queue()).length, 1)
   await sync.apply([remote('local', '200', true)])
   assert.equal((await queue()).length, 0)
})

test('must-refetch invalidates the cached snapshot', async () => {
   await sync.apply([remote('local', '300')])
   await db.exec('TRUNCATE todo')
   await seed()
   await sync.reset()
   await app.flushQueue()
   await sync.apply([todo('old')])
   assert.deepEqual(await rows(), [todo()])
   assert.equal((await queue()).length, 1)
   await sync.apply([remote('local', '300')])
   assert.equal((await queue()).length, 0)
})

test('server versions retain precision above the JavaScript integer limit', async () => {
   await seed()
   await db.query('UPDATE mutation_queue SET acknowledged_version = $1', ['9007199254740993'])
   await sync.apply([remote('old', '9007199254740992')])
   assert.equal((await queue()).length, 1)
   await sync.apply([remote('local', '9007199254740993')])
   assert.equal((await queue()).length, 0)
})

test('an absent row cannot acknowledge a delete without its versioned tombstone', async () => {
   await seed('delete')
   fetchHandler = async () => new Response(null, { status: 204, headers: { 'X-Sync-Version': '200' } })
   await app.flushQueue()
   await sync.apply([])
   assert.equal((await queue()).length, 1)
   await sync.apply([remote('old', '100')])
   assert.deepEqual(await rows(), [])
   await sync.apply([remote('', '200', true)])
   assert.equal((await queue()).length, 0)
})

test('a create retry receiving a tombstone waits for that tombstone instead of recreating the row', async () => {
   await seed('create')
   fetchHandler = async () => new Response(JSON.stringify(remote('', '200', true)), {
      headers: { 'X-Sync-Version': '200' },
   })
   await app.flushQueue()
   assert.equal((await queue())[0].acknowledged_version, '200')
   await sync.apply([remote('', '200', true)])
   assert.deepEqual(await rows(), [])
   assert.equal((await queue()).length, 0)
})

test('an API response without a version leaves the mutation retryable', async () => {
   await seed()
   fetchHandler = async () => new Response(JSON.stringify(todo()))
   await app.flushQueue()
   assert.equal((await queue())[0].acknowledged_version, null)
   await sync.apply([remote('old', '100')])
   assert.deepEqual(await rows(), [todo()])
})

test('the service supports offline CRUD and change notifications without a UI', async () => {
   const changes = []
   const offline = createTodoSync(db, { network: { onLine: false } })
   const unsubscribe = offline.subscribe((change) => changes.push(change))
   const createdId = await offline.createTodo('Offline todo')
   assert.deepEqual(await offline.getTodos(), [{ id: createdId, label: 'Offline todo', completed: false, pending: true }])
   assert.deepEqual(await offline.getStatus(), { online: false, pending: 1, failed: 0 })
   await offline.editTodo(createdId, 'Edited offline', true)
   assert.equal((await offline.getTodos())[0].label, 'Edited offline')
   await offline.deleteTodo(createdId)
   assert.deepEqual(await offline.getTodos(), [])
   assert.deepEqual(changes, ['todos', 'todos', 'todos'])
   unsubscribe()
   await offline.createTodo('No listener')
   assert.equal(changes.length, 3)
})

test('queue processing notifies subscribers and exposes failure counts as data', async () => {
   await seed()
   const changes = []
   app.subscribe((change) => changes.push(change))
   fetchHandler = async () => new Response(null, { status: 400 })
   await app.flushQueue()
   assert.deepEqual(await app.getStatus(), { online: false, pending: 0, failed: 1 })
   assert(changes.includes('todos'))
   assert(changes.includes('status'))
   assert.equal((await app.getTodos())[0].pending, true)
})
