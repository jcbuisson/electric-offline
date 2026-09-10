
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
   let latest = null
   let work = Promise.resolve()

   // in-memory queue of functions; makes snapshot operations run one at a time, in the order they were requested
   function enqueue(task) {
      const result = work.then(task)
      work = result.catch(() => {})
      return result
   }

   async function reconcile() {
      if (!latest) return
      await db.transaction(async (tx) => {
         for (const row of latest) {
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
         await tx.query(
            `DELETE FROM todo
             WHERE NOT (id = ANY($1::uuid[]))
               AND NOT EXISTS (
                  SELECT 1 FROM mutation_queue
                  WHERE table_name = 'todo' AND row_id = todo.id::text
               )`,
            [latest.filter((row) => !row.deleted).map((row) => row.id)],
         )
      })
   }

   return {

      // receive a new Electric snapshot
      apply(rows) {
         return enqueue(async () => {
            latest = rows
            await reconcile()
         })
      },

      // Recheck the previously received snapshot
      reconcile: () => enqueue(reconcile),

      // Forget the previous snapshot
      reset: () => enqueue(() => { latest = null }),
   }
}
