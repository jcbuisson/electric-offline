import { Shape, ShapeStream } from '@electric-sql/client'
import { createSnapshotSync } from './snapshotSync.js'

// Owns local mutations, the HTTP queue and Electric. No DOM or UI formatting.
export function createTodoSync(db, {
   snapshotSync = createSnapshotSync(db),
   fetchRequest = (...args) => fetch(...args),
   network = globalThis.navigator,
   events = globalThis.window,
   shapeUrl = 'http://localhost:3200/v1/shape',
} = {}) {
   let flushing = false
   let syncConnected = false
   let started = false
   let retryTimer
   let streamController
   const listeners = new Set()

   // 'todos' means rows or pending flags changed; 'status' means connection/queue status changed.
   function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
   }

   function notify(change) {
      for (const listener of listeners) {
         // Rendering errors must not affect mutation acknowledgement or retries.
         Promise.resolve().then(() => listener(change)).catch(console.error)
      }
   }

   function start() {
      if (started) return
      started = true
      streamController = new AbortController()
      events.addEventListener('online', handleOnline)
      events.addEventListener('offline', handleOffline)
      startElectricSync()
      void flushQueue()
      retryTimer = setInterval(flushQueue, 5_000)
   }

   function stop() {
      if (!started) return
      started = false
      clearInterval(retryTimer)
      events.removeEventListener('online', handleOnline)
      events.removeEventListener('offline', handleOffline)
      streamController.abort()
      syncConnected = false
      notify('status')
   }

   function handleOnline() {
      notify('status')
      void flushQueue()
   }

   function handleOffline() {
      notify('status')
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
      notify('todos')
      if (started) void flushQueue()
      return id
   }

   async function editTodo(id, label, completed) {
      const cleanLabel = label.trim()
      if (!cleanLabel) return notify('todos')

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
                    action = CASE WHEN acknowledged_version IS NOT NULL THEN 'update' ELSE action END,
                    acknowledged_version = NULL,
                    status = 'pending',
                    failure_reason = NULL
                WHERE seq = $2`,
               [JSON.stringify({ label: cleanLabel, completed }), existingMutation.seq],
            )
         } else if (existingMutation.action === 'delete') {
            throw new Error(`Cannot edit todo with pending delete mutation`)
         }
      })
      notify('todos')
      if (started) void flushQueue()
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
               "UPDATE mutation_queue SET action = 'delete', payload = NULL, acknowledged_version = NULL, status = 'pending', failure_reason = NULL WHERE seq = $1",
               [existingMutation.seq],
            )
         } else if (existingMutation.action === 'delete') {
            // a delete is already queued; no queue change is needed
         }
      })
      notify('todos')
      if (started) void flushQueue()
   }

   async function getTodos() {
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
      return rows
   }

   function startElectricSync() {
      const stream = new ShapeStream({
         url: shapeUrl,
         signal: streamController.signal,
         params: {
            table: 'todo',
            where: 'true',
         },
      })

      // individual row changes and control messages
      stream.subscribe(
         (messages) => {
            // must-refetch is a message from Electric meaning: “Discard the old shape snapshot and fetch it again”
            // This can happen when Electric invalidates a shape, for example after a schema change
            if (messages.some((message) => message.headers.control === 'must-refetch')) {
               snapshotSync.reset()
            }
            syncConnected = stream.isConnected()
            notify('status')
         },
         (error) => {
            console.error('Electric sync error:', error)
            syncConnected = false
            notify('status')
         },
      )

      const shape = new Shape(stream)

      // the accumulated remote dataset, maintained from stream.subscribe() messages
      shape.subscribe(async ({ rows }) => {
         syncConnected = true
         await snapshotSync.apply(rows)
         notify('todos')
      })
   }

   async function flushQueue() {
      if (!network.onLine) return
      if (network.locks) {
         await network.locks.request('todo-mutation-queue', { ifAvailable: true }, async (lock) => {
            if (lock) await flushQueueUnlocked()
         })
         return
      }
      await flushQueueUnlocked()
   }

   async function flushQueueUnlocked() {
      if (flushing || !network.onLine) return
      flushing = true
      try {
         while (true) {
            const { rows } = await db.query("SELECT * FROM mutation_queue WHERE status = 'pending' AND acknowledged_version IS NULL ORDER BY seq LIMIT 1")
            const mutation = rows[0]
            if (!mutation) break
            try {
               await sendMutation(mutation)
            } catch (error) {
               if (!isPermanentMutationError(error)) throw error
               await markMutationFailed(mutation, error)
            }
            notify('todos')
         }
      } catch (error) {
         console.info('Mutation queue will retry:', error.message)
      } finally {
         flushing = false
         notify('status')
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
         const { data: serverTodo, version } = await api('/api/todos', {
            method: 'POST',
            body: JSON.stringify({ id: rowId, ...payload }),
         })
         await db.transaction(async (tx) => {
            const stillQueued = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
            const currentMutation = stillQueued.rows[0]
            if (!currentMutation || currentMutation.action !== 'create') return
            if (serverTodo.deleted || sameTodo(serverTodo, currentMutation.payload)) {
               await tx.query('UPDATE mutation_queue SET acknowledged_version = $1 WHERE seq = $2', [version, mutation.seq])
            } else {
               await tx.query("UPDATE mutation_queue SET action = 'update' WHERE seq = $1", [mutation.seq])
            }
         })
      }

      else if (mutation.action === 'update') {
         const { response, version } = await api(`/api/todos/${rowId}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
         }, true)
         await db.transaction(async (tx) => {
            const current = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
            if (sameMutation(current.rows[0], mutation)) {
               await tx.query('UPDATE mutation_queue SET acknowledged_version = $1 WHERE seq = $2', [version, mutation.seq])
            }
            if (response.status === 404) await tx.query('DELETE FROM todo WHERE id = $1', [rowId])
         })
      }

      else if (mutation.action === 'delete') {
         const { version } = await api(`/api/todos/${rowId}`, { method: 'DELETE' }, true)
         await db.query('UPDATE mutation_queue SET acknowledged_version = $1 WHERE seq = $2', [version, mutation.seq])
      }

      else {
         // defensive - should not happen
         throw new PermanentMutationError(`Unsupported todo mutation action: ${mutation.action}`)
      }
      // Electric may have reached this write before its HTTP response arrived.
      await snapshotSync.reconcile()
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
      const response = await fetchRequest(url, {
         ...options,
         signal: options.signal ?? AbortSignal.timeout(15_000),
         headers: { 'content-type': 'application/json', ...options.headers },
      })
      if (!response.ok && !(allowNotFound && response.status === 404)) {
         throw new ApiError(response.status)
      }
      const version = response.headers.get('X-Sync-Version')
      if (!version || !/^\d+$/.test(version)) throw new Error('API did not return a sync version')
      const data = response.status === 204 || response.status === 404 ? null : await response.json()
      return { response, data, version }
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

   async function getStatus() {
      const { rows } = await db.query(`
         SELECT
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM mutation_queue
      `)
      const { pending, failed } = rows[0]
      const online = network.onLine && syncConnected
      return { online, pending, failed }
   }

   return {
      start,
      stop,
      subscribe,
      getTodos,
      getStatus,
      createTodo: insertTodoLocally,
      editTodo,
      deleteTodo,
      flushQueue,
   }
}
