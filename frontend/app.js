import { db, prepareLocalDB } from './createLocalDB.js'
import { createTodoSync } from './todoSync.js'
import { createDirectorySync } from './directorySync.js'
import { createDirectoryUI } from './directoryUI.js'
import { createTodoUI } from './todoUI.js'

await prepareLocalDB()
const todos = createTodoSync(db, { ownsSync: false, channel: new BroadcastChannel('offline-todos-events') })
await createTodoUI(todos)
todos.start()
const directory = createDirectorySync(db, { ownsSync: false, channel: new BroadcastChannel('offline-directory-events') })
await createDirectoryUI(directory)
directory.start()

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
   navigator.serviceWorker.register('/sw.js')
}
