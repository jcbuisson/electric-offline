import { Shape, ShapeStream } from '@electric-sql/client'
import { createSnapshotSync } from './snapshotSync.js'

// This service connects three places: the UI, local PGlite, and the server.
//
// A change follows this path:
// 1. createTodo/editTodo/deleteTodo change PGlite and save a mutation in its queue.
// 2. notify('todos') tells the UI to read PGlite again, even while offline.
// 3. flushQueue() sends queued mutations to the HTTP API, which writes to Postgres.
// 4. The API returns X-Sync-Version. We save it as acknowledged_version.
// 5. Electric delivers that server version (or newer). snapshotSync then removes
//    the queue entry and applies the remote data in one local transaction.
//
// Step 4 does NOT remove the queue entry: it still protects the local change
// against older Electric snapshots. For a deletion, Electric sends a tombstone
// (a server row with deleted = true and a version), which is hidden from the UI.
//
// Each local change also has a revision, separate from the server's version.
// Revisions order requests from this client; versions confirm delivery by Electric.
// Client identity and revision numbers survive reloads in PGlite. Retrying sends
// the same revision, so a delayed request cannot overwrite a newer local change.
//
// db is the local PGlite database. The optional dependencies below normally use
// browser objects, but tests can supply an isolated database and fake network.
export function createTodoSync(db, {
   snapshotSync = createSnapshotSync(db),
   fetchRequest = (...args) => fetch(...args),
   network = globalThis.navigator,
   events = globalThis.window,
   shapeUrl = 'http://localhost:3200/v1/shape',
} = {}) {
   // These flags belong to this service instance; the mutation queue is in PGlite.
   let flushing = false // Prevent overlapping queue flushes in this instance.
   let syncConnected = false // Whether Electric has reported a connection/data.
   let started = false // Whether automatic sync and retry triggers are enabled.
   let retryTimer
   let streamController
   const listeners = new Set()

   // The UI subscribes here to learn when it should read fresh data.
   // 'todos' means rows or their pending flags changed; 'status' means sync status changed.
   // The returned function unsubscribes this listener.
   function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
   }

   // Send an event name, not DOM elements or formatted text. Listeners decide how to react.
   function notify(change) {
      for (const listener of listeners) {
         // Rendering errors must not affect mutation acknowledgement or retries.
         Promise.resolve().then(() => listener(change)).catch(console.error)
      }
   }

   // Start receiving Electric data and sending local mutations. Repeated calls do nothing.
   function start() {
      if (started) return
      started = true
      streamController = new AbortController()
      events.addEventListener('online', handleOnline)
      events.addEventListener('offline', handleOffline)
      startElectricSync()
      // `void` starts the async flush without waiting for it here.
      void flushQueue()
      // Also retry when the API recovers without a browser online event.
      retryTimer = setInterval(flushQueue, 5_000)
   }

   // Stop the Electric stream, timer and online/offline listeners. Keep local data.
   // This does not cancel an HTTP mutation or queue flush that is already running.
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

   // Browser connectivity is a hint, not proof that our API or Electric is reachable.
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
      // Save the visible todo and its queued create together: both succeed or both roll back.
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

   // Save the latest desired label/completed values, merging edits into one queue entry.
   async function editTodo(id, label, completed) {
      const cleanLabel = label.trim()
      // An empty edit leaves the database unchanged; ask the UI to show the stored value.
      if (!cleanLabel) return notify('todos')

      await db.transaction(async (tx) => {
         // Make the edit visible locally before waiting for any network request.
         await tx.query(
            'UPDATE todo SET label = $1, completed = $2 WHERE id = $3',
            [cleanLabel, completed, id],
         )

         // The database allows at most one queue entry per table and row ID.
         // Reuse it rather than adding an entry for every keystroke or checkbox change.
         const queued = await tx.query(
            "SELECT seq, action, status FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1 ORDER BY seq LIMIT 1",
            [id],
         )
         const existingMutation = queued.rows[0]
         if (!existingMutation) {
            // No outstanding mutation: send these values as a new update.
            await tx.query(
               `INSERT INTO mutation_queue (table_name, action, row_id, payload)
                VALUES ('todo', 'update', $1, $2::jsonb)`,
               [id, JSON.stringify({ label: cleanLabel, completed })],
            )
         } else if (existingMutation.action === 'create' || existingMutation.action === 'update') {
            // Replace the queued values with the newest local values.
            // If a create was already acknowledged, the next request must be an UPDATE.
            // Clear its old acknowledgement: that version cannot confirm this new edit.
            // A previously failed mutation also becomes eligible for another attempt.
            await tx.query(
               `UPDATE mutation_queue
                SET payload = $1::jsonb,
                    action = CASE WHEN acknowledged_version IS NOT NULL THEN 'update' ELSE action END,
                    revision = nextval('mutation_revision_seq'),
                    acknowledged_version = NULL,
                    status = 'pending',
                    failure_reason = NULL
                WHERE seq = $2`,
               [JSON.stringify({ label: cleanLabel, completed }), existingMutation.seq],
            )
         } else if (existingMutation.action === 'delete') {
            // Throwing rolls back the local UPDATE above as well.
            throw new Error(`Cannot edit todo with pending delete mutation`)
         }
      })
      notify('todos')
      if (started) void flushQueue()
   }

   // Remove the visible local row, but keep a queued delete until Electric confirms it.
   async function deleteTodo(id) {
      await db.transaction(async (tx) => {
         // The UI reads this table, so the todo disappears immediately.
         await tx.query('DELETE FROM todo WHERE id = $1', [id])

         // Replace an outstanding create/update with a delete for the same ID.
         const queued = await tx.query(
            "SELECT seq, action, status FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1 ORDER BY seq LIMIT 1",
            [id],
         )
         const existingMutation = queued.rows[0]
         if (!existingMutation) {
            // A delete needs only the ID; there is no label/completed payload.
            await tx.query(
               "INSERT INTO mutation_queue (table_name, action, row_id) VALUES ('todo', 'delete', $1)",
               [id],
            )
         } else if (existingMutation.action === 'create' || existingMutation.action === 'update') {
            // Do not simply cancel a queued create: its HTTP request may already
            // be running or may have succeeded before a connection failure.
            await tx.query(
               "UPDATE mutation_queue SET action = 'delete', revision = nextval('mutation_revision_seq'), payload = NULL, acknowledged_version = NULL, status = 'pending', failure_reason = NULL WHERE seq = $1",
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
      // Read only local data. `pending` means ANY queue entry still protects the row,
      // including failed entries and acknowledged entries waiting for Electric.
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

   // Read path: Electric supplies changes committed in Postgres, including other clients
   // and our own API writes. It does not receive our offline PGlite edits directly.
   function startElectricSync() {
      const stream = new ShapeStream({
         url: shapeUrl,
         signal: streamController.signal,
         params: {
            table: 'todo',
            // Include deleted rows too: their versions confirm queued deletions.
            where: 'true',
         },
      })

      // First callback: batches of raw row changes and control messages.
      // Second callback: errors reported by the stream.
      stream.subscribe(
         (messages) => {
            // Electric is rebuilding the shape. Forget our cached remote snapshot,
            // but keep local todos and mutations. The client handles the refetch.
            // Register this callback before Shape so reset is queued before new data.
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

      // Shape assembles the stream messages into a dataset. `rows` is that dataset,
      // not just the rows changed by the latest message. Apply it before notifying the UI.
      shape.subscribe(async ({ rows }) => {
         syncConnected = true
         await snapshotSync.apply(rows)
         notify('todos')
      })
   }

   // Send eligible mutations. Offline calls leave them stored for a later attempt.
   async function flushQueue() {
      if (!network.onLine) return
      // When Web Locks are available, only one cooperating tab can flush at a time.
      // ifAvailable skips this attempt instead of waiting behind another tab.
      if (network.locks) {
         await network.locks.request('todo-mutation-queue', { ifAvailable: true }, async (lock) => {
            if (lock) await flushQueueUnlocked()
         })
         return
      }
      await flushQueueUnlocked()
   }

   // Process requests sequentially. `flushing` also prevents overlap when Web Locks
   // are unavailable or several triggers call this service at once.
   async function flushQueueUnlocked() {
      if (flushing || !network.onLine) return
      flushing = true
      try {
         while (true) {
            // Skip failed entries and writes already acknowledged by the API.
            // Acknowledged writes stay in the queue solely to await Electric.
            const { rows } = await db.query("SELECT * FROM mutation_queue WHERE status = 'pending' AND acknowledged_version IS NULL ORDER BY seq LIMIT 1")
            const mutation = rows[0]
            if (!mutation) break
            try {
               await sendMutation(mutation)
            } catch (error) {
               // Permanent failures are recorded so other mutations can continue.
               // Temporary failures exit this flush and leave the entry retryable.
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

   // Dispatch by table name; this app currently has only the todo handler.
   async function sendMutation(mutation) {
      const handler = mutationHandlers[mutation.table_name]
      if (!handler) throw new PermanentMutationError(`No mutation handler for table: ${mutation.table_name}`)
      await handler(mutation)
   }

   const mutationHandlers = {
      todo: sendTodoMutation,
   }

   // `mutation` is what we read before sending the request. The user can edit/delete
   // the same todo while we await HTTP, so we must re-read the queue afterwards.
   async function sendTodoMutation(mutation) {
      const rowId = mutation.row_id
      const payload = mutation.payload
      // A retry keeps its revision; each new local change gets a larger one.
      // The server uses these headers to ignore a late request after a newer write.
      const { rows: clients } = await db.query('SELECT id FROM sync_client WHERE singleton = true')
      const headers = {
         'X-Sync-Client': clients[0].id,
         'X-Mutation-Revision': String(mutation.revision),
      }

      if (mutation.action === 'create') {
         const { data: serverTodo, version } = await api('/api/todos', {
            method: 'POST',
            headers,
            body: JSON.stringify({ id: rowId, ...payload }),
         })
         await db.transaction(async (tx) => {
            const stillQueued = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
            const currentMutation = stillQueued.rows[0]
            // A queued delete must survive the response to this earlier create.
            if (!currentMutation || currentMutation.action !== 'create') return
            // Matching values need only Electric confirmation. A server tombstone
            // also wins: retrying a create must not resurrect a deleted UUID.
            if (serverTodo.deleted || sameTodo(serverTodo, currentMutation.payload)) {
               await tx.query('UPDATE mutation_queue SET acknowledged_version = $1 WHERE seq = $2', [version, mutation.seq])
            } else {
               // The server row differs from our current desired values (for example,
               // the user edited during POST). Send those values in a following PUT.
               // This is a different request, so it must get a new revision too.
               await tx.query("UPDATE mutation_queue SET action = 'update', revision = nextval('mutation_revision_seq') WHERE seq = $1", [mutation.seq])
            }
         })
      }

      else if (mutation.action === 'update') {
         const { response, version } = await api(`/api/todos/${rowId}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify(payload),
         }, true)
         await db.transaction(async (tx) => {
            const current = await tx.query('SELECT * FROM mutation_queue WHERE seq = $1', [mutation.seq])
            // This response acknowledges only the values actually sent, not a newer edit.
            if (sameMutation(current.rows[0], mutation)) {
               await tx.query('UPDATE mutation_queue SET acknowledged_version = $1 WHERE seq = $2', [version, mutation.seq])
            }
            // The server has no active todo. Hide it locally; the queue guard remains
            // until the corresponding server version arrives through Electric.
            if (response.status === 404) await tx.query('DELETE FROM todo WHERE id = $1', [rowId])
         })
      }

      else if (mutation.action === 'delete') {
         // Keep the queue entry after HTTP success so an old snapshot cannot restore
         // the deleted todo. The replicated tombstone will release this guard.
         const { version } = await api(`/api/todos/${rowId}`, { method: 'DELETE', headers }, true)
         await db.query('UPDATE mutation_queue SET acknowledged_version = $1 WHERE seq = $2', [version, mutation.seq])
      }

      else {
         // defensive - should not happen
         throw new PermanentMutationError(`Unsupported todo mutation action: ${mutation.action}`)
      }
      // Electric may have delivered the version BEFORE HTTP returned. Recheck the
      // cached snapshot now that acknowledged_version is saved; no new message is needed.
      await snapshotSync.reconcile()
   }

   function sameTodo(todo, payload) {
      return todo.label === payload.label && todo.completed === payload.completed
   }

   // Record rejection without throwing away the local edit. Do not attach an old
   // request's failure to a mutation whose action or values have since changed.
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

   // Most 4xx responses need a correction rather than automatic retries. Treat
   // 408/425/429 as temporary, along with network errors, timeouts and 5xx responses.
   function isPermanentMutationError(error) {
      return error instanceof PermanentMutationError ||
         error instanceof ApiError && error.status >= 400 && error.status < 500 &&
         error.status !== 408 && error.status !== 425 && error.status !== 429
   }

   // Shared HTTP helper. UPDATE/DELETE accept 404 as a result to reconcile, rather
   // than a permanent error. Even then, the response must provide a sync version.
   async function api(url, options, allowNotFound = false) {
      const response = await fetchRequest(url, {
         ...options,
         signal: options.signal ?? AbortSignal.timeout(15_000),
         headers: { 'content-type': 'application/json', ...options.headers },
      })
      if (!response.ok && !(allowNotFound && response.status === 404)) {
         throw new ApiError(response.status)
      }
      // This is our API's custom header, not an Electric header. Keep it as a string
      // so large database versions never lose precision as JavaScript numbers.
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

   // Compare the request contents, not status/acknowledgement metadata.
   function sameMutation(a, b) {
      return a && a.table_name === b.table_name && a.action === b.action &&
         a.row_id === b.row_id && String(a.revision) === String(b.revision) && JSON.stringify(a.payload) === JSON.stringify(b.payload)
   }

   // Return data for the UI to format. Pending includes acknowledged writes still
   // waiting for Electric; an empty HTTP send queue does not necessarily mean synced.
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

   // Public API used by todoUI.js and app.js. Local CRUD works before start();
   // start() enables automatic sending, receiving and retrying.
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
