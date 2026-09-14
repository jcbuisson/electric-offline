import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { PGlite } from '@electric-sql/pglite'
import { applyTodoMutation } from '../backend/todoMutations.js'
import { createTodoSync } from '../frontend/todoSync.js'
import { createSnapshotSync } from '../frontend/snapshotSync.js'

const local = new PGlite()
const server = new PGlite()
const id = '11111111-1111-4111-8111-111111111111'
let sync, service, requestHandler, prepareLocal

before(async () => {
   const localSource = await readFile(new URL('../frontend/localSchema.js', import.meta.url), 'utf8')
   const localContext = vm.createContext({ db: local })
   vm.runInContext(localSource.slice(localSource.indexOf('export async')).replace('export ', ''), localContext)
   prepareLocal = () => localContext.prepareLocalDB(local)
   await prepareLocal()
   const serverSource = await readFile(new URL('../backend/createServerDB.js', import.meta.url), 'utf8')
   const serverContext = vm.createContext({ pool: { query: (sql) => server.exec(sql) } })
   vm.runInContext(serverSource.slice(serverSource.indexOf('export async')).replace('export ', ''), serverContext)
   await serverContext.createServerDB()
   await serverContext.createServerDB()
})
after(async () => { await local.close(); await server.close() })
beforeEach(async () => {
   await local.exec('TRUNCATE todo, mutation_queue')
   await server.exec('TRUNCATE todo, todo_mutation_cursor')
   sync = createSnapshotSync(local)
   service = newService()
   requestHandler = commitRequest
})
function newService() {
   return createTodoSync(local, {
      snapshotSync: sync, network: { onLine: true },
      fetchRequest: (...args) => requestHandler(...args),
   })
}
async function commitRequest(url, options) {
   const payload = options.body ? JSON.parse(options.body) : {}
   const action = { POST: 'create', PUT: 'update', DELETE: 'delete' }[options.method]
   const result = await server.transaction((tx) => applyTodoMutation(tx, {
      id: action === 'create' ? payload.id : url.split('/').at(-1), action,
      label: payload.label, completed: payload.completed,
      clientId: options.headers['X-Sync-Client'], revision: options.headers['X-Mutation-Revision'],
   }))
   return new Response(result.status === 204 || result.status === 404 ? null : JSON.stringify(result.todo), {
      status: result.status, headers: { 'X-Sync-Version': String(result.todo.version) },
   })
}
const queue = async () => (await local.query('SELECT * FROM mutation_queue')).rows
const snapshot = async () => sync.apply((await server.query('SELECT * FROM todo')).rows)
async function seed() {
   await server.query("INSERT INTO todo (id,label,completed) VALUES ($1,'initial',false)", [id])
   await snapshot()
}

test('a timed-out PUT arriving after a newer PUT cannot revert it', async () => {
   await seed()
   let delayed
   requestHandler = async (...args) => { delayed = args; throw new Error('Simulated timeout') }
   await service.editTodo(id, 'older edit', false)
   await service.flushQueue()
   const oldRevision = (await queue())[0].revision
   requestHandler = commitRequest
   await service.editTodo(id, 'newer edit', true)
   assert(BigInt((await queue())[0].revision) > BigInt(oldRevision))
   await service.flushQueue()
   await snapshot()
   const before = (await server.query('SELECT * FROM todo')).rows
   await commitRequest(...delayed)
   assert.deepEqual((await server.query('SELECT * FROM todo')).rows, before)
   await snapshot()
   assert.equal((await service.getTodos())[0].label, 'newer edit')
   assert.equal((await service.getTodos())[0].completed, true)
   assert.equal((await queue()).length, 0)
})

test('retrying a committed request preserves another client’s intervening edit', async () => {
   await seed()
   let committed
   requestHandler = async (...args) => { committed = args; await commitRequest(...args); throw new Error('Lost response') }
   await service.editTodo(id, 'my edit', false)
   await service.flushQueue()
   const myClient = committed[1].headers['X-Sync-Client']
   await server.transaction((tx) => applyTodoMutation(tx, {
      id, action: 'update', label: 'other client', completed: true,
      clientId: '22222222-2222-4222-8222-222222222222', revision: '1',
   }))
   // Recreating the service/database initializer must preserve client identity and revision.
   await prepareLocal()
   service = newService()
   requestHandler = async (...args) => {
      assert.equal(args[1].headers['X-Sync-Client'], myClient)
      assert.equal(args[1].headers['X-Mutation-Revision'], committed[1].headers['X-Mutation-Revision'])
      return commitRequest(...args)
   }
   await service.flushQueue()
   await snapshot()
   assert.equal((await service.getTodos())[0].label, 'other client')
   assert.equal((await queue()).length, 0)
})

test('editing during POST gives the follow-up PUT a fresh revision', async () => {
   let postRevision
   requestHandler = async (url, options) => {
      if (options.method === 'POST') {
         postRevision = options.headers['X-Mutation-Revision']
         await service.editTodo(JSON.parse(options.body).id, 'edited during create', true)
      } else {
         assert(BigInt(options.headers['X-Mutation-Revision']) > BigInt(postRevision))
      }
      return commitRequest(url, options)
   }
   await service.createTodo('initial create')
   await service.flushQueue()
   await snapshot()
   assert.equal((await service.getTodos())[0].label, 'edited during create')
   assert.equal((await queue()).length, 0)
})

test('a delayed PUT cannot overwrite a later deletion', async () => {
   await seed()
   let delayed
   requestHandler = async (...args) => { delayed = args; throw new Error('Simulated timeout') }
   await service.editTodo(id, 'late edit', false)
   await service.flushQueue()
   requestHandler = commitRequest
   await service.deleteTodo(id)
   await service.flushQueue()
   await commitRequest(...delayed)
   await snapshot()
   assert.equal((await server.query('SELECT deleted FROM todo')).rows[0].deleted, true)
   assert.deepEqual(await service.getTodos(), [])
   assert.equal((await queue()).length, 0)
})

test('a failed transaction does not consume its revision', async () => {
   const mutation = { id, clientId: crypto.randomUUID(), revision: '1', action: 'create', label: null, completed: false }
   await assert.rejects(server.transaction((tx) => applyTodoMutation(tx, mutation)))
   assert.equal((await server.query('SELECT * FROM todo_mutation_cursor')).rows.length, 0)
   const result = await server.transaction((tx) => applyTodoMutation(tx, { ...mutation, label: 'valid retry' }))
   assert.equal(result.todo.label, 'valid retry')
})

test('mutation revisions above the JavaScript integer limit remain ordered', async () => {
   await seed()
   const mutation = { id, clientId: crypto.randomUUID(), action: 'update', completed: false }
   await server.transaction((tx) => applyTodoMutation(tx, { ...mutation, revision: '9007199254740993', label: 'newer' }))
   await server.transaction((tx) => applyTodoMutation(tx, { ...mutation, revision: '9007199254740992', label: 'older' }))
   assert.equal((await server.query('SELECT label FROM todo')).rows[0].label, 'newer')
})

test('a superseded create receives the deletion marker as JSON-compatible data', async () => {
   const mutation = { id, clientId: crypto.randomUUID() }
   await server.transaction((tx) => applyTodoMutation(tx, { ...mutation, action: 'delete', revision: '2' }))
   const response = await server.transaction((tx) => applyTodoMutation(tx, {
      ...mutation, action: 'create', revision: '1', label: 'late create', completed: false,
   }))
   assert.equal(response.status, 201)
   assert.equal(response.todo.deleted, true)
   assert.equal((await server.query('SELECT deleted FROM todo')).rows[0].deleted, true)
})
