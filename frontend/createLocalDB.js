import { PGliteWorker } from '@electric-sql/pglite/worker'

// Reuse this origin's existing PGlite store, including unsent directory changes.
// New installations use a directory-specific name. An explicit setting resolves
// ambiguity if an origin contains more than one PGlite database.
const stores = (await indexedDB.databases()).map(db => db.name).filter(name => name?.startsWith('/pglite/'))
const configured = import.meta.env.VITE_LOCAL_DATA_DIR
if (!configured && stores.length > 1) throw new Error('Set VITE_LOCAL_DATA_DIR to select your local database')
const dataDir = configured || (stores.length ? `idb://${stores[0].slice('/pglite/'.length)}` : 'idb://directory')

// Every tab has a worker, but only the elected worker opens the database.
export const db = new PGliteWorker(
   new Worker(new URL('./databaseWorker.js', import.meta.url), { type: 'module' }),
   { id: 'offline-directory-db', dataDir },
)

export async function prepareLocalDB() {
   await db.waitReady
}
