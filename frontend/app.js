import { db, prepareLocalDB } from './createLocalDB.js'
import { createDirectorySync } from './directorySync.js'
import { createDirectoryUI } from './directoryUI.js'

await prepareLocalDB()
const directory = createDirectorySync(db, { ownsSync: false, channel: new BroadcastChannel('offline-directory-events') })
await createDirectoryUI(directory)
directory.start()

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
   navigator.serviceWorker.register('/sw.js')
}
