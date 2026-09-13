
// This module copies Electric's remote dataset into local PGlite, while preserving
// local changes that Electric has not confirmed yet. It makes no HTTP requests
// and does not render the UI; todoSync.js calls its three public methods.
//
// Two local tables are involved:
// - todo: the rows displayed by the UI, including the user's offline edits.
// - mutation_queue: outstanding changes. An entry protects its todo from being
//   overwritten or removed by an older remote snapshot.
//
// The API stores its returned version in mutation_queue.acknowledged_version.
// We remove that entry only when Electric delivers the same row at that version
// or newer. The queue is persisted in PGlite, so protection survives a reload.
// Deleted server rows are kept as tombstones (deleted = true, with a version).
// They confirm deletions but are never inserted into the visible local todo table.

// Example:
//    Event                                   Result
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//    User change "Milk" to "Bread" locally   Local row becomes "Bread"; mutation is queued
//   ──────────────────────────────────────  ────────────────────────────────────────────────
//    API confirms server version 42          Queue entry gets acknowledged_version = 42
//   ──────────────────────────────────────  ────────────────────────────────────────────────
//    Electric sends old version 41           Queue entry stays; local "Bread" stays
//   ──────────────────────────────────────  ────────────────────────────────────────────────
//    Electric sends version 42               Queue entry is removed; remote data is applied

// HTTP success means the server handled the write. It does not mean Electric has
// delivered it yet. A missing row in an old snapshot is not proof of a deletion;
// the version on its tombstone is the proof we wait for.
export function createSnapshotSync(db) {
   // The most recently received remote dataset, kept only in memory.
   // null means "no usable snapshot"; [] means "a usable snapshot with no rows".
   let latestRows = null
   // Tracks completion of the last scheduled operation. Starting with an already
   // resolved Promise allows the first operation to run immediately in a microtask.
   let previousOperation = Promise.resolve()

   // These functions share the variables above through a JavaScript closure.
   // Their declarations are available here even though they are written below.
   return { apply, reconcile, reset }

   // Called by todoSync.js when Shape delivers its accumulated remote rows.
   // `rows` must be the whole dataset, not just the latest insert/update messages:
   // updateLocalTodos also uses it to determine which local rows are now absent.
   // Remembering and applying this snapshot happen inside the same ordered task.
   function apply(rows) {
      return runInOrder(async () => {
         latestRows = rows
         await updateLocalTodos(db, rows)
      })
   }

   // Called after todoSync.js saves an HTTP acknowledgement in the queue.
   // Electric can arrive BEFORE the HTTP response:
   //   - apply() sees remote version 42, but acknowledged_version is still NULL.
   //   - The HTTP response then saves acknowledged_version = 42.
   //   - reconcile() reuses that cached snapshot and can now clear the entry.
   // This avoids waiting for another Electric message that might never be needed.
   function reconcile() {
      return runInOrder(async () => {
         // After startup or reset(), there is no snapshot to recheck yet.
         // An empty array is still valid and must be processed.
         if (latestRows === null) return
         await updateLocalTodos(db, latestRows)
      })
   }

   // Called for Electric's must-refetch message. Forget only the cached remote
   // dataset, not local todos or queued mutations. Electric handles fetching again.
   // A reconcile() scheduled after this reset will do nothing until apply() runs.
   function reset() {
      return runInOrder(() => {
         latestRows = null
      })
   }

   // This is an in-memory queue of operations, separate from mutation_queue in SQL.
   // apply(A), reset(), apply(B) must finish in that order, even without caller awaits.
   // Otherwise one operation could replace the cached snapshot while another runs.
   function runInOrder(operation) {
      // Schedule this function after the previously scheduled operation finishes.
      const currentOperation = previousOperation.then(operation)
      // Use a caught Promise as the starting point for the next operation.
      // Without this catch, one failure would cause later .then() tasks to be skipped.
      previousOperation = currentOperation.catch(() => {})
      // Return the original Promise, so this caller can still await it and receive
      // its error. The catch above keeps the queue moving; it does not retry the task.
      return currentOperation
   }
}

// Apply one remote dataset to local PGlite. This function uses only its arguments;
// it does not access latestRows or make decisions about operation ordering.
//
// All SQL runs in one transaction: clearing a queue entry and applying the remote
// row commit together. If any query fails, every change in this transaction rolls
// back, so a row cannot lose its protection without the corresponding data update.
async function updateLocalTodos(db, rows) {
   await db.transaction(async (tx) => {
      for (const row of rows) {
         // 1. Clear mutations whose server version has arrived in Electric.
         // A newer server version also confirms the write, even when another
         // client changed the row again before we received our HTTP response.
         // In SQL, NULL <= a version is not true: unacknowledged mutations stay.
         // A row without a version cannot confirm anything, so skip this check.
         // String + SQL numeric comparison preserves large integer versions.
         if (row.version !== undefined) {
            await tx.query(
               `DELETE FROM mutation_queue
                WHERE table_name = 'todo' AND row_id = $1
                  AND acknowledged_version <= $2::numeric`,
               [row.id, String(row.version)],
            )
         }
         // 2. Copy active rows only when no local mutation still protects them.
         // A tombstone can release the guard in step 1, but it is not a visible todo.
         // Step 3 below removes its local row if no mutation still protects it.
         if (row.deleted) continue
         // INSERT ... SELECT produces no row when a queue entry still exists.
         // Otherwise ON CONFLICT updates the local row if its ID is already present.
         await tx.query(
            `INSERT INTO todo (id, label, completed)
             SELECT $1::uuid, $2, $3::boolean
             WHERE NOT EXISTS (
                SELECT 1 FROM mutation_queue WHERE table_name = 'todo' AND row_id = $1::text
             )
             ON CONFLICT (id) DO UPDATE SET label = excluded.label, completed = excluded.completed`,
            [row.id, row.label, row.completed],
         )
      }
      // 3. Remove missing or deleted rows, except those with a local mutation.
      // Build the IDs of active remote rows (exclude tombstones). ANY checks whether
      // a local ID is in that array; NOT reverses the check to find absent IDs.
      // The queue check preserves offline creates and other protected local changes.
      // An empty ID array therefore removes only unprotected local rows.
      await tx.query(
         `DELETE FROM todo
          WHERE NOT (id = ANY($1::uuid[]))
            AND NOT EXISTS (
               SELECT 1 FROM mutation_queue
               WHERE table_name = 'todo' AND row_id = todo.id::text
            )`,
         [rows.filter((row) => !row.deleted).map((row) => row.id)],
      )
   })
}
