import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'
import { prepareLocalDB } from './localSchema.js'
import { prepareDirectoryLocal } from './directorySchema.js'
import { createDirectorySync } from './directorySync.js'
import { createTodoSync } from './todoSync.js'
import wasmUrl from '../node_modules/@electric-sql/pglite/dist/pglite.wasm?url'
import initdbUrl from '../node_modules/@electric-sql/pglite/dist/initdb.wasm?url'
import bundleUrl from '../node_modules/@electric-sql/pglite/dist/pglite.data?url'

// PGliteWorker closes a tab's reply channel when that tab leaves. A query
// already running may finish afterward and try to reply to that closed channel.
// The database work is still valid; only this undeliverable reply is discarded.
// Keep every other worker error visible.
globalThis.addEventListener('unhandledrejection', event => {
   const error = event.reason
   if (error?.name === 'InvalidStateError' && error.message.includes('BroadcastChannel') && error.message.includes('closed')) {
      event.preventDefault()
   }
})

// Load in EVERY worker before joining the election. A follower must be able to
// open the database after the leader closes, even if the browser is now offline.
const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
   fetch(wasmUrl).then(r => r.arrayBuffer()).then(WebAssembly.compile),
   fetch(initdbUrl).then(r => r.arrayBuffer()).then(WebAssembly.compile),
   fetch(bundleUrl).then(r => r.blob()),
])

await worker({
   async init(options) {
      const db = new PGlite({ ...options, pgliteWasmModule, initdbWasmModule, fsBundle })
      await prepareLocalDB(db)
      await prepareDirectoryLocal(db)
      // Only the elected worker reaches init: it owns both the database and sync.
      const todos = createTodoSync(db, {
         events: globalThis,
         channel: new BroadcastChannel('offline-todos-events'),
         fetchRequest: (url, options) => fetch(new URL(url, location.origin), options),
      })
      todos.start()
      const directory = createDirectorySync(db, {
         channel: new BroadcastChannel('offline-directory-events'),
         fetchRequest: (url, options) => fetch(new URL(url, location.origin), options),
      })
      directory.start()
      return db
   },
})
