import { db, prepareLocalDB } from './createLocalDB.js'
import { createTodoSync } from './todoSync.js'
import { createTodoUI } from './todoUI.js'

await prepareLocalDB()
const todos = createTodoSync(db)
await createTodoUI(todos)
todos.start()

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
   navigator.serviceWorker.register('/sw.js')
}
