import { Shape, ShapeStream } from '@electric-sql/client'
import { db, prepareLocalDB } from './createLocalDB.js'

const list = document.querySelector('#todo-list')
const empty = document.querySelector('#empty')
const form = document.querySelector('#new-todo-form')
const input = document.querySelector('#new-todo')
const status = document.querySelector('#status')

let flushing = false
let syncConnected = false

await prepareLocalDB()
await render()

form.addEventListener('submit', createTodo)
window.addEventListener('online', () => {
   updateStatus()
   flushQueue()
})
window.addEventListener('offline', updateStatus)

startElectricSync()
flushQueue()
setInterval(flushQueue, 5_000)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
   navigator.serviceWorker.register('/sw.js')
}

async function createTodo(event) {
   event.preventDefault()
   const label = input.value.trim()
   if (!label) return

   await insertTodoLocally(label)
   input.value = ''
   await render()
   flushQueue()
}

// The client-generated UUID is the permanent primary key, so retrying a create
// cannot produce another server row and no temporary ID reconciliation is needed.
async function insertTodoLocally(label) {
   const id = crypto.randomUUID()
   await db.transaction(async (tx) => {
      await tx.query('INSERT INTO todo (id, label, completed) VALUES ($1, $2, false)', [id, label])
      await tx.query(
         `INSERT INTO mutation_queue (table_name, action, row_id, payload)
          VALUES ('todo', 'create', $1, $2::jsonb)`,
         [id, JSON.stringify({ label, completed: false })],
      )
   })
}

async function editTodo(id, label, completed) {
   const cleanLabel = label.trim()
   if (!cleanLabel) return render()

   await db.transaction(async (tx) => {
      // update local database
      await tx.query(
         'UPDATE todo SET label = $1, completed = $2 WHERE id = $3',
         [cleanLabel, completed, id],
      )

      // update mutation queue
      // look for an existing (max 1) mutation relative to the same table and row_id
      const queued = await tx.query(
         "SELECT seq, action, status FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1 ORDER BY seq LIMIT 1",
         [id],
      )
      const existingMutation = queued.rows[0]
      if (!existingMutation) {
         // queue a new update mutation
         await tx.query(
            `INSERT INTO mutation_queue (table_name, action, row_id, payload)
             VALUES ('todo', 'update', $1, $2::jsonb)`,
            [id, JSON.stringify({ label: cleanLabel, completed })],
         )
      } else if (existingMutation.action === 'create' || existingMutation.action === 'update') {
         // update existing mutation payload
         await tx.query(
            `UPDATE mutation_queue
             SET payload = $1::jsonb,
                 status = 'pending',
                 failure_reason = NULL
             WHERE seq = $2`,
            [JSON.stringify({ label: cleanLabel, completed }), existingMutation.seq],
         )
      } else if (existingMutation.action === 'delete') {
         throw new Error(`Cannot edit todo with pending delete mutation`)
      }
   })
   await render()
   flushQueue()
}

async function deleteTodo(id) {
   await db.transaction(async (tx) => {
      // update local database
      await tx.query('DELETE FROM todo WHERE id = $1', [id])

      // update mutation queue
      // look for an existing (max 1) mutation relative to the same table and row_id
      const queued = await tx.query(
         "SELECT seq, action, status FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1 ORDER BY seq LIMIT 1",
         [id],
      )
      const existingMutation = queued.rows[0]
      if (!existingMutation) {
         // queue a new delete mutation
         await tx.query(
            "INSERT INTO mutation_queue (table_name, action, row_id) VALUES ('todo', 'delete', $1)",
            [id],
         )
      } else if (existingMutation.action === 'create' || existingMutation.action === 'update') {
         // A create may already be in flight, so a delete must still reach the server.
         await tx.query(
            "UPDATE mutation_queue SET action = 'delete', payload = NULL, status = 'pending', failure_reason = NULL WHERE seq = $1",
            [existingMutation.seq],
         )
      } else if (existingMutation.action === 'delete') {
         // a delete is already queued; no queue change is needed
      }
   })
   await render()
   flushQueue()
}

async function render() {
   // returns every todo and adds a computed 'pending' boolean
   const { rows } = await db.query(`
      SELECT todo.*,
         EXISTS (
            SELECT 1 FROM mutation_queue
            WHERE mutation_queue.table_name = 'todo'
              AND mutation_queue.row_id = todo.id::text
         ) AS pending
      FROM todo
      ORDER BY id
   `)
   list.replaceChildren(...rows.map(todoElement))
   empty.hidden = rows.length > 0
   updateStatus()
}

function todoElement(todo) {
   const item = document.createElement('li')
   item.className = `${todo.completed ? 'completed ' : ''}${todo.pending ? 'pending' : ''}`.trim()

   const checkbox = document.createElement('input')
   checkbox.type = 'checkbox'
   checkbox.checked = todo.completed
   checkbox.setAttribute('aria-label', `Mark ${todo.label} complete`)
   checkbox.addEventListener('change', () => editTodo(todo.id, todo.label, checkbox.checked))

   const label = document.createElement('span')
   label.className = 'label'
   label.contentEditable = 'plaintext-only'
   label.textContent = todo.label
   label.setAttribute('role', 'textbox')
   label.setAttribute('aria-label', `Edit ${todo.label}`)
   label.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
         event.preventDefault()
         label.blur()
      }
      if (event.key === 'Escape') {
         label.textContent = todo.label
         label.blur()
      }
   })
   label.addEventListener('blur', () => {
      if (label.textContent !== todo.label) editTodo(todo.id, label.textContent, todo.completed)
   })

   const localId = document.createElement('span')
   localId.className = 'local-id'
   localId.textContent = `#${todo.id}`
   localId.title = 'Local database ID'

   const description = document.createElement('div')
   description.className = 'todo-description'
   description.append(label, localId)

   const remove = document.createElement('button')
   remove.className = 'delete'
   remove.type = 'button'
   remove.textContent = '×'
   remove.setAttribute('aria-label', `Delete ${todo.label}`)
   remove.addEventListener('click', () => deleteTodo(todo.id))

   item.append(checkbox, description, remove)
   return item
}

/*
   The mutation lifecycle is:
   1. A local change updates todo and adds a queue entry.
   2. flushQueue() sends that mutation to the API.
   3. A successful HTTP response acknowledges it.
   4. sendTodoMutation() removes or transforms the queue entry.
   5. Electric later delivers the resulting server state.
*/

function startElectricSync() {
   const stream = new ShapeStream({
      url: 'http://localhost:3200/v1/shape',
      params: {
         table: 'todo',
         where: 'true',
      },
   })
   const shape = new Shape(stream)

   // Subscribe to shape's current dataset
   shape.subscribe(async ({ rows }) => {
      syncConnected = true
      await applyRemoteSnapshot(rows)
      await render()
   })

   // Subscribe to raw Electric protocol messages: insert, update, delete, up-to-date, must-refetch, etc.
   // Used here to update sync status
   stream.subscribe(
      () => {
         syncConnected = stream.isConnected()
         updateStatus()
      },
      () => {
         syncConnected = false
         updateStatus()
      },
   )
}

async function applyRemoteSnapshot(remoteRows) {
   // `remoteRows` is a complete, up-to-date shape's table snapshot
   // update local database table
   const remoteIds = remoteRows.map((row) => row.id)
   await db.transaction(async (tx) => {
      for (const row of remoteRows) {
         const id = row.id
         const queued = await tx.query(
            "SELECT 1 FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1 LIMIT 1",
            [id],
         )
         // if there is a pending mutation for this row, snapshot data is ignored
         if (queued.rows[0]) continue

         await tx.query(
            `INSERT INTO todo (id, label, completed) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET label = excluded.label, completed = excluded.completed`,
            [id, row.label, row.completed],
         )
      }

      if (remoteIds.length) {
         await tx.query(`
            DELETE FROM todo
            WHERE NOT (id = ANY($1::uuid[]))
              AND NOT EXISTS (
                 SELECT 1 FROM mutation_queue
                 WHERE mutation_queue.table_name = 'todo' AND mutation_queue.row_id = todo.id::text
              )
         `, [remoteIds])
      } else {
         await tx.query(`
            DELETE FROM todo
            WHERE NOT EXISTS (
                 SELECT 1 FROM mutation_queue
                 WHERE mutation_queue.table_name = 'todo' AND mutation_queue.row_id = todo.id::text
              )
         `)
      }
   })
}

async function flushQueue() {
   if (!navigator.onLine) return
   if (navigator.locks) {
      await navigator.locks.request('todo-mutation-queue', { ifAvailable: true }, async (lock) => {
         if (lock) await flushQueueUnlocked()
      })
      return
   }
   await flushQueueUnlocked()
}

async function flushQueueUnlocked() {
   if (flushing || !navigator.onLine) return
   flushing = true
   try {
      while (true) {
         const { rows } = await db.query("SELECT * FROM mutation_queue WHERE status = 'pending' ORDER BY seq LIMIT 1")
         const mutation = rows[0]
         if (!mutation) break
         try {
            await sendMutation(mutation)
         } catch (error) {
            if (!isPermanentMutationError(error)) throw error
            await markMutationFailed(mutation, error)
         }
         await render()
      }
   } catch (error) {
      console.info('Mutation queue will retry:', error.message)
   } finally {
      flushing = false
      updateStatus()
   }
}

async function sendMutation(mutation) {
   const handler = mutationHandlers[mutation.table_name]
   if (!handler) throw new PermanentMutationError(`No mutation handler for table: ${mutation.table_name}`)
   await handler(mutation)
}

const mutationHandlers = {
   todo: sendTodoMutation,
}

async function sendTodoMutation(mutation) {
   const rowId = mutation.row_id
   const payload = mutation.payload

   if (mutation.action === 'create') {
      const serverTodo = await api('/api/todos', {
         method: 'POST',
         body: JSON.stringify({ id: rowId, ...payload }),
      })
      await db.transaction(async (tx) => {
         const stillQueued = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
         const currentMutation = stillQueued.rows[0]
         if (!currentMutation || currentMutation.action !== 'create') return
         if (sameTodo(serverTodo, currentMutation.payload)) {
            await tx.query('DELETE FROM mutation_queue WHERE seq = $1', [mutation.seq])
         } else {
            await tx.query("UPDATE mutation_queue SET action = 'update' WHERE seq = $1", [mutation.seq])
         }
      })
   }

   else if (mutation.action === 'update') {
      const response = await api(`/api/todos/${rowId}`, {
         method: 'PUT',
         body: JSON.stringify(payload),
      }, true)
      await db.transaction(async (tx) => {
         const current = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
         if (sameMutation(current.rows[0], mutation)) {
            await tx.query('DELETE FROM mutation_queue WHERE seq = $1', [mutation.seq])
         }
         if (response.status === 404) await tx.query('DELETE FROM todo WHERE id = $1', [rowId])
      })
   }

   else if (mutation.action === 'delete') {
      await api(`/api/todos/${rowId}`, { method: 'DELETE' }, true)
      await db.query('DELETE FROM mutation_queue WHERE seq = $1', [mutation.seq])
   }

   else {
      // defensive - should not happen
      throw new PermanentMutationError(`Unsupported todo mutation action: ${mutation.action}`)
   }
}

function sameTodo(todo, payload) {
   return todo.label === payload.label && todo.completed === payload.completed
}

async function markMutationFailed(mutation, error) {
   await db.transaction(async (tx) => {
      const current = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
      if (!sameMutation(current.rows[0], mutation)) return
      await tx.query(
         "UPDATE mutation_queue SET status = 'failed', failure_reason = $1 WHERE seq = $2",
         [error.message, mutation.seq],
      )
   })
}

function isPermanentMutationError(error) {
   return error instanceof PermanentMutationError ||
      error instanceof ApiError && error.status >= 400 && error.status < 500 &&
      error.status !== 408 && error.status !== 425 && error.status !== 429
}

async function api(url, options, allowNotFound = false) {
   const response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', ...options.headers },
   })
   if (!response.ok && !(allowNotFound && response.status === 404)) {
      throw new ApiError(response.status)
   }
   if (response.status === 204 || response.status === 404) return response
   return response.json()
}

class ApiError extends Error {
   constructor(status) {
      super(`API returned ${status}`)
      this.status = status
   }
}

class PermanentMutationError extends Error {}

function sameMutation(a, b) {
   return a && a.table_name === b.table_name && a.action === b.action &&
      a.row_id === b.row_id && JSON.stringify(a.payload) === JSON.stringify(b.payload)
}

async function updateStatus() {
   const { rows } = await db.query(`
      SELECT
         count(*) FILTER (WHERE status = 'pending')::int AS pending,
         count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM mutation_queue
   `)
   const { pending, failed } = rows[0]
   const online = navigator.onLine && syncConnected
   status.className = `status ${online ? 'online' : 'offline'}`
   if (failed) {
      status.textContent = `${online ? 'Online' : 'Offline'} · ${failed} failed${pending ? ` · ${pending} pending` : ''}`
   } else {
      status.textContent = online ? (pending ? `Online · ${pending} pending` : 'Synced') : (pending ? `Offline · ${pending} pending` : 'Offline')
   }
}
