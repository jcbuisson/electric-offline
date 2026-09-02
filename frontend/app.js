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

   const id = -Math.floor(1 + Math.random() * 2_000_000_000)
   await db.transaction(async (tx) => {
      await tx.query('INSERT INTO todo (id, label, completed, pending) VALUES ($1, $2, false, true)', [id, label])
      await tx.query(
         `INSERT INTO mutation_queue (action, todo_id, label, completed)
         VALUES ('create', $1, $2, false)`,
         [id, label],
      )
   })
   input.value = ''
   await render()
   flushQueue()
}

async function editTodo(id, label, completed) {
   const cleanLabel = label.trim()
   if (!cleanLabel) return render()

   await db.transaction(async (tx) => {
      await tx.query(
         'UPDATE todo SET label = $1, completed = $2, pending = true WHERE id = $3',
         [cleanLabel, completed, id],
      )
      const queued = await tx.query('SELECT seq, action FROM mutation_queue WHERE todo_id = $1 ORDER BY seq LIMIT 1', [id])
      if (queued.rows[0]?.action === 'create') {
         await tx.query('UPDATE mutation_queue SET label = $1, completed = $2 WHERE seq = $3', [cleanLabel, completed, queued.rows[0].seq])
      } else if (queued.rows[0]?.action === 'update') {
         await tx.query('UPDATE mutation_queue SET label = $1, completed = $2 WHERE seq = $3', [cleanLabel, completed, queued.rows[0].seq])
      } else {
         await tx.query(
         `INSERT INTO mutation_queue (action, todo_id, label, completed)
            VALUES ('update', $1, $2, $3)`,
         [id, cleanLabel, completed],
         )
      }
   })
   await render()
   flushQueue()
}

async function deleteTodo(id) {
   await db.transaction(async (tx) => {
      await tx.query('DELETE FROM todo WHERE id = $1', [id])
      const queued = await tx.query('SELECT seq, action FROM mutation_queue WHERE todo_id = $1 ORDER BY seq LIMIT 1', [id])
      if (queued.rows[0]?.action === 'create') {
         await tx.query('DELETE FROM mutation_queue WHERE todo_id = $1', [id])
      } else {
         await tx.query('DELETE FROM mutation_queue WHERE todo_id = $1', [id])
         await tx.query("INSERT INTO mutation_queue (action, todo_id) VALUES ('delete', $1)", [id])
      }
   })
   await render()
   flushQueue()
}

async function render() {
   const { rows } = await db.query('SELECT * FROM todo ORDER BY id')
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

   const remove = document.createElement('button')
   remove.className = 'delete'
   remove.type = 'button'
   remove.textContent = '×'
   remove.setAttribute('aria-label', `Delete ${todo.label}`)
   remove.addEventListener('click', () => deleteTodo(todo.id))

   item.append(checkbox, label, remove)
   return item
}

function startElectricSync() {
   const stream = new ShapeStream({
      url: 'http://localhost:3200/v1/shape',
      params: { table: 'todo', where: 'true' },
   })
   const shape = new Shape(stream)

   shape.subscribe(async ({ rows }) => {
      syncConnected = true
      await applyRemoteRows(rows)
      await render()
   })

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

async function applyRemoteRows(remoteRows) {
   const remoteIds = remoteRows.map((row) => Number(row.id))
   await db.transaction(async (tx) => {
      for (const row of remoteRows) {
         const id = Number(row.id)
         const local = await tx.query('SELECT pending FROM todo WHERE id = $1', [id])
         if (local.rows[0]?.pending) continue
         await tx.query(
         `INSERT INTO todo (id, label, completed, pending) VALUES ($1, $2, $3, false)
            ON CONFLICT (id) DO UPDATE SET label = excluded.label, completed = excluded.completed`,
         [id, row.label, row.completed],
         )
      }

      if (remoteIds.length) {
         await tx.query('DELETE FROM todo WHERE id > 0 AND pending = false AND NOT (id = ANY($1::int[]))', [remoteIds])
      } else {
         await tx.query('DELETE FROM todo WHERE id > 0 AND pending = false')
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
   if (mutation.action === 'create') {
      const serverTodo = await api('/api/todos', {
         method: 'POST',
         body: JSON.stringify({ label: mutation.label, completed: mutation.completed }),
      })
      await db.transaction(async (tx) => {
         const current = await tx.query('SELECT * FROM todo WHERE id = $1', [mutation.todo_id])
         const stillQueued = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
         await tx.query('DELETE FROM todo WHERE id = $1', [mutation.todo_id])
         if (!current.rows[0] || !stillQueued.rows[0]) {
         await tx.query('DELETE FROM mutation_queue WHERE seq = $1', [mutation.seq])
         await tx.query("INSERT INTO mutation_queue (action, todo_id) VALUES ('delete', $1)", [serverTodo.id])
         return
         }
         await tx.query(
         'INSERT INTO todo (id, label, completed, pending) VALUES ($1, $2, $3, true)',
         [serverTodo.id, current.rows[0].label, current.rows[0].completed],
         )
         await tx.query(
         "UPDATE mutation_queue SET action = 'update', todo_id = $1, label = $2, completed = $3 WHERE seq = $4",
         [serverTodo.id, current.rows[0].label, current.rows[0].completed, mutation.seq],
         )
      })
      return
   }

   if (mutation.action === 'update') {
      const response = await api(`/api/todos/${mutation.todo_id}`, {
         method: 'PUT',
         body: JSON.stringify({ label: mutation.label, completed: mutation.completed }),
      }, true)
      await db.transaction(async (tx) => {
         const current = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
         if (sameMutation(current.rows[0], mutation)) {
         await tx.query('DELETE FROM mutation_queue WHERE seq = $1', [mutation.seq])
         await tx.query('UPDATE todo SET pending = false WHERE id = $1', [mutation.todo_id])
         }
         if (response.status === 404) await tx.query('DELETE FROM todo WHERE id = $1', [mutation.todo_id])
      })
      return
   }

   await api(`/api/todos/${mutation.todo_id}`, { method: 'DELETE' }, true)
   await db.query('DELETE FROM mutation_queue WHERE seq = $1', [mutation.seq])
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
   return a && a.action === b.action && a.todo_id === b.todo_id &&
      a.label === b.label && a.completed === b.completed
}

async function updateStatus() {
   const { rows } = await db.query('SELECT count(*)::int AS count FROM mutation_queue')
   const pending = rows[0].count
   const online = navigator.onLine && syncConnected
   status.className = `status ${online ? 'online' : 'offline'}`
   status.textContent = online ? (pending ? `Online · ${pending} pending` : 'Synced') : (pending ? `Offline · ${pending} pending` : 'Offline')
}
