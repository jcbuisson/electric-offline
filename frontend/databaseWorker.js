import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'
import { prepareLocalDB } from './localSchema.js'
import { createTodoSync } from './todoSync.js'
import wasmUrl from '../node_modules/@electric-sql/pglite/dist/pglite.wasm?url'
import initdbUrl from '../node_modules/@electric-sql/pglite/dist/initdb.wasm?url'
import bundleUrl from '../node_modules/@electric-sql/pglite/dist/pglite.data?url'

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
      // Only the elected worker reaches init: it owns both the database and sync.
      const todos = createTodoSync(db, {
         events: globalThis,
         channel: new BroadcastChannel('offline-todos-events'),
         fetchRequest: (url, options) => fetch(new URL(url, location.origin), options),
      })
      todos.start()
      return db
   },
})
