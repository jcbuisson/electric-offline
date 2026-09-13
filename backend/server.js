import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServerDB, pool } from './createServerDB.js'

const app = express()
const port = Number(process.env.PORT || 3001)

app.use(express.json())

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
app.use(express.static(dist))
app.get('*path', (_request, response) => response.sendFile(path.join(dist, 'index.html')))

app.use((error, _request, response, _next) => {
   console.error(error)
   const status = error.status || 500
   response.status(status).json({ error: status === 500 ? 'Database request failed' : error.message })
})

start().catch((error) => {
   console.error('Failed to start Todo API:', error)
   process.exitCode = 1
})

async function start() {
   await createServerDB()
   app.listen(port, () => console.log(`Todo API listening on http://localhost:${port}`))
}


// CREATE
app.post('/api/todos', async (request, response, next) => {
   try {
      const id = requireId(request.body.id)
      const label = requireLabel(request.body.label)
      const completed = Boolean(request.body.completed)
      const created = await pool.query(
         `INSERT INTO todo (id, label, completed) VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET id = excluded.id
          RETURNING *`,
         [id, label, completed],
      )
      response.set('X-Sync-Version', String(created.rows[0].version))
      response.status(201).json(created.rows[0])
   } catch (error) {
      next(error)
   }
})

// UPDATE
app.put('/api/todos/:id', async (request, response, next) => {
   try {
      const id = requireId(request.params.id)
      const label = requireLabel(request.body.label)
      const { rows } = await pool.query(
         "UPDATE todo SET label = $1, completed = $2, version = nextval('todo_version_seq') WHERE id = $3 AND NOT deleted RETURNING *", [label, Boolean(request.body.completed), id],
      )
      if (!rows[0]) {
         const tombstone = await ensureTombstone(id)
         response.set('X-Sync-Version', String(tombstone.version))
         return response.sendStatus(404)
      }
      response.set('X-Sync-Version', String(rows[0].version))
      response.json(rows[0])
   } catch (error) {
      next(error)
   }
})

// DELETE
app.delete('/api/todos/:id', async (request, response, next) => {
   try {
      const { rows } = await pool.query(
         `INSERT INTO todo (id, label, deleted) VALUES ($1, '', true)
          ON CONFLICT (id) DO UPDATE SET label = '', completed = false,
             deleted = true, version = nextval('todo_version_seq')
          RETURNING version`,
         [requireId(request.params.id)],
      )
      response.set('X-Sync-Version', String(rows[0].version))
      response.sendStatus(204)
   } catch (error) {
      next(error)
   }
})


function requireId(value) {
   if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw badRequest('Invalid todo id')
   }
   return value
}

function requireLabel(value) {
   if (typeof value !== 'string' || !value.trim()) throw badRequest('Label is required')
   return value.trim()
}

function badRequest(message) {
   return Object.assign(new Error(message), { status: 400 })
}

// If the ID is missing: creates a tombstone with deleted = true. The database assigns a version automatically.
// If the ID already exists: preserves its data and returns its existing version.
async function ensureTombstone(id) {
   const { rows } = await pool.query(
      `INSERT INTO todo (id, label, deleted) VALUES ($1, '', true)
       ON CONFLICT (id) DO UPDATE SET id = excluded.id RETURNING version`,
      [id],
   )
   return rows[0]
}
