
// Local changes remain protected until Electric delivers the acknowledged server version or newer—even across reloads.
// Deletes now retain hidden, versioned tombstones so stale snapshots cannot resurrect them.

// Exemple:
//    Event                                   Result
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//    You change "Milk" to "Bread" locally    Local row becomes "Bread"; mutation is queued
//   ──────────────────────────────────────  ────────────────────────────────────────────────
//    API confirms server version 42          Queue entry gets acknowledged_version = 42
//   ──────────────────────────────────────  ────────────────────────────────────────────────
//    Electric sends old version 41           Queue entry stays; local "Bread" stays
//   ──────────────────────────────────────  ────────────────────────────────────────────────
//    Electric sends version 42               Queue entry is removed; remote data is applied

// HTTP acknowledges durability; the replicated version acknowledges visibility.
// Delete tombstones carry a version too, so absence alone never clears a guard.
export function createSnapshotSync(db) {
   let latestRows = null
   let previousOperation = Promise.resolve()

   return { apply, reconcile, reset }

   // Electric delivered a new snapshot: remember it and update the local database.
   function apply(rows) {
      return runInOrder(async () => {
         latestRows = rows
         await updateLocalTodos(db, rows)
      })
   }

   // An HTTP response arrived: recheck the snapshot we already have.
   function reconcile() {
      return runInOrder(async () => {
         if (latestRows === null) return
         await updateLocalTodos(db, latestRows)
      })
   }

   // Electric requested a fresh snapshot: stop using the previous one.
   function reset() {
      return runInOrder(() => {
         latestRows = null
      })
   }

   // Finish each operation before starting the next, even if callers don't await it.
   function runInOrder(operation) {
      const currentOperation = previousOperation.then(operation)
      // A failed operation must not prevent later operations from running.
      previousOperation = currentOperation.catch(() => {})
      // The caller still receives the error from this operation.
      return currentOperation
   }
}

// All three steps commit together. This function uses the snapshot passed to it;
// it does not read or change the snapshot remembered by createSnapshotSync.
async function updateLocalTodos(db, rows) {
   await db.transaction(async (tx) => {
      for (const row of rows) {
         // 1. Clear mutations whose server version has arrived in Electric.
         // A newer server version also confirms the write, even when another
         // client changed the row again before we received our HTTP response.
         if (row.version !== undefined) {
            await tx.query(
               `DELETE FROM mutation_queue
                WHERE table_name = 'todo' AND row_id = $1
                  AND acknowledged_version <= $2::numeric`,
               [row.id, String(row.version)],
            )
         }
         // 2. Copy active rows only when no local mutation still protects them.
         if (row.deleted) continue
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
