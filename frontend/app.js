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

   await insertTodoWithUniqueLocalId(label)
   input.value = ''
   await render()
   flushQueue()
}

async function insertTodoWithUniqueLocalId(label) {
   const maxAttempts = 10
   for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // the generated local id is negative so that it cannot conflict with server database ids
      const id = -Math.floor(1 + Math.random() * 2_000_000_000)
      try {
         await db.transaction(async (tx) => {
            await tx.query('INSERT INTO todo (id, label, completed) VALUES ($1, $2, false)', [id, label])
            // NOTE that row_id is a string, to accomodate all types of primary keys
            await tx.query(
               `INSERT INTO mutation_queue (table_name, action, row_id, payload) VALUES ('todo', 'create', $1, $2::jsonb)`,
               [String(id), JSON.stringify({ label, completed: false })],
            )
         })
         return
      } catch (error) {
         if (error.code !== '23505' // unique constraint violation
            || attempt === maxAttempts) throw error
      }
   }
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
         "SELECT seq, action FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1 ORDER BY seq LIMIT 1",
         [String(id)],
      )
      const existingMutation = queued.rows[0]
      if (!existingMutation) {
         // queue a new update mutation
         await tx.query(
            `INSERT INTO mutation_queue (table_name, action, row_id, payload) VALUES ('todo', 'update', $1, $2::jsonb)`,
            [String(id), JSON.stringify({ label: cleanLabel, completed })],
         )
      } else if (existingMutation.action === 'create' || existingMutation.action === 'update') {
         // update existing mutation payload
         await tx.query('UPDATE mutation_queue SET payload = $1::jsonb WHERE seq = $2', [JSON.stringify({ label: cleanLabel, completed }), existingMutation.seq])
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
         "SELECT seq, action FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1 ORDER BY seq LIMIT 1",
         [String(id)],
      )
      const existingMutation = queued.rows[0]
      if (!existingMutation) {
         // queue a new delete mutation
         await tx.query(
            "INSERT INTO mutation_queue (table_name, action, row_id) VALUES ('todo', 'delete', $1)",
            [String(id)],
         )
      } else if (existingMutation.action === 'create') {
         // the row never reached the server, so cancel its pending create
         await tx.query('DELETE FROM mutation_queue WHERE seq = $1', [existingMutation.seq])
      } else if (existingMutation.action === 'update') {
         // replace the pending update with a delete
         await tx.query(
            "UPDATE mutation_queue SET action = 'delete', payload = NULL WHERE seq = $1",
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
   const remoteIds = remoteRows.map((row) => Number(row.id))
   await db.transaction(async (tx) => {
      for (const row of remoteRows) {
         const id = Number(row.id)
         const queued = await tx.query(
            "SELECT 1 FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1 LIMIT 1",
            [String(id)],
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
            WHERE id > 0
              AND NOT (id = ANY($1::int[]))
              AND NOT EXISTS (
                 SELECT 1 FROM mutation_queue
                 WHERE mutation_queue.table_name = 'todo' AND mutation_queue.row_id = todo.id::text
              )
         `, [remoteIds])
      } else {
         await tx.query(`
            DELETE FROM todo
            WHERE id > 0
              AND NOT EXISTS (
                 SELECT 1 FROM mutation_queue
                 WHERE mutation_queue.table_name = 'todo' AND mutation_queue.row_id = todo.id::text
              )
         `)
      }
   })
}

async function flushQueue() {
   if (flushing || !navigator.onLine) return
   flushing = true
   try {
      while (true) {
         const { rows } = await db.query('SELECT * FROM mutation_queue ORDER BY seq LIMIT 1')
         const mutation = rows[0]
         if (!mutation) break
         await sendMutation(mutation)
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
   if (!handler) throw new Error(`No mutation handler for table: ${mutation.table_name}`)
   await handler(mutation)
}

const mutationHandlers = {
   todo: sendTodoMutation,
}

async function sendTodoMutation(mutation) {
   const rowId = Number(mutation.row_id)
   const payload = mutation.payload

   if (mutation.action === 'create') {
      const serverTodo = await api('/api/todos', {
         method: 'POST',
         body: JSON.stringify(payload),
      })
      await db.transaction(async (tx) => {
         const current = await tx.query('SELECT * FROM todo WHERE id = $1', [rowId])
         const stillQueued = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
         await tx.query('DELETE FROM todo WHERE id = $1', [rowId])

         if (current.rows[0] && stillQueued.rows[0]) {
            await tx.query(
               'INSERT INTO todo (id, label, completed) VALUES ($1, $2, $3)',
               [serverTodo.id, current.rows[0].label, current.rows[0].completed],
            )
            await tx.query(
               "UPDATE mutation_queue SET action = 'update', row_id = $1, payload = $2::jsonb WHERE seq = $3",
               [String(serverTodo.id), JSON.stringify({ label: current.rows[0].label, completed: current.rows[0].completed }), mutation.seq],
            )
         } else {
            await tx.query('DELETE FROM mutation_queue WHERE seq = $1', [mutation.seq])
            await tx.query(
               "INSERT INTO mutation_queue (table_name, action, row_id) VALUES ('todo', 'delete', $1)",
               [String(serverTodo.id)],
            )
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
      throw new Error(`Unsupported todo mutation action: ${mutation.action}`)
   }
}

async function api(url, options, allowNotFound = false) {
   const response = await fetch(url, {
      ...options,
      headers: { 'content-type': 'application/json', ...options.headers },
   })
   if (!response.ok && !(allowNotFound && response.status === 404)) {
      throw new Error(`API returned ${response.status}`)
   }
   if (response.status === 204 || response.status === 404) return response
   return response.json()
}

function sameMutation(a, b) {
   return a && a.table_name === b.table_name && a.action === b.action &&
      a.row_id === b.row_id && JSON.stringify(a.payload) === JSON.stringify(b.payload)
}

async function updateStatus() {
   const { rows } = await db.query('SELECT count(*)::int AS count FROM mutation_queue')
   const pending = rows[0].count
   const online = navigator.onLine && syncConnected
   status.className = `status ${online ? 'online' : 'offline'}`
   status.textContent = online ? (pending ? `Online · ${pending} pending` : 'Synced') : (pending ? `Offline · ${pending} pending` : 'Offline')
}
