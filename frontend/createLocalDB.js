import { PGliteWorker } from '@electric-sql/pglite/worker'

// Every tab has a worker, but PGliteWorker elects only one to open idb://todo.
// Keeping the existing dataDir preserves todos and pending mutations on upgrade.
export const db = new PGliteWorker(
   new Worker(new URL('./databaseWorker.js', import.meta.url), { type: 'module' }),
   { id: 'offline-todos-db', dataDir: 'idb://todo' },
)

export async function prepareLocalDB() {
   await db.waitReady
}
