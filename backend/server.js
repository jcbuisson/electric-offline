import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServerDB, pool } from './createServerDB.js'
import { directoryRouter } from './directoryRouter.js'

const app = express()
const port = Number(process.env.PORT || 3001)
app.use(express.json())
app.use('/api/directory', directoryRouter(pool))

start().catch(error => {
   console.error('Failed to start Directory API:', error)
   process.exitCode = 1
})

async function start() {
   await createServerDB()
   app.listen(port, () => console.log(`Directory API listening on http://localhost:${port}`))
}

// Register API routes before the SPA fallback, and errors after the routes.
app.use('/api', (_request, response) => response.status(404).json({ error: 'Unknown API route' }))
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
app.use(express.static(dist))
app.get('*path', (_request, response) => response.sendFile(path.join(dist, 'index.html')))
app.use((error, _request, response, _next) => {
   console.error(error)
   const status = error.status || 500
   response.status(status).json({ error: status === 500 ? 'Database request failed' : error.message })
})
