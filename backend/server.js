import express from 'express'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServerDB, pool } from './createServerDB.js'

const app = express()
const port = Number(process.env.PORT || 3001)

app.use(express.json())

// Each queued mutation keeps a stable idempotency key so retrying after a lost response cannot apply the same server operation twice
// Used here only for a create, since re-applying an update or a delete causes no problem. Reapplying a create would create duplicates


// CREATE
app.post('/api/todos', async (request, response, next) => {
   const client = await pool.connect()
   try {
      const idempotencyKey = requireIdempotencyKey(request.get('idempotency-key'))
      const label = requireLabel(request.body.label)
      const completed = Boolean(request.body.completed)
      const requestHash = createHash('sha256')
         .update(JSON.stringify({ label, completed }))
         .digest('hex')

      await client.query('BEGIN')
      const reservation = await client.query(
         `INSERT INTO idempotency_requests (key, request_hash)
          VALUES ($1, $2)
          ON CONFLICT (key) DO NOTHING
          RETURNING key`,
         [idempotencyKey, requestHash],
      )

      if (!reservation.rows[0]) {
         const existing = await client.query(
            'SELECT request_hash, response FROM idempotency_requests WHERE key = $1',
            [idempotencyKey],
         )
         if (existing.rows[0].request_hash !== requestHash) {
            throw conflict('Idempotency key reused with a different request')
         }
         await client.query('COMMIT')
         return response.status(201).json(existing.rows[0].response)
      }

      const { rows } = await client.query(
         'INSERT INTO todo (label, completed) VALUES ($1, $2) RETURNING *', [label, completed],
      )
      await client.query(
         'UPDATE idempotency_requests SET response = $2::jsonb WHERE key = $1',
         [idempotencyKey, JSON.stringify(rows[0])],
      )
      await client.query('COMMIT')
      response.status(201).json(rows[0])
   } catch (error) {
      await client.query('ROLLBACK')
      next(error)
   } finally {
      client.release()
   }
})

// UPDATE
app.put('/api/todos/:id', async (request, response, next) => {
   try {
      const id = requireId(request.params.id)
      const label = requireLabel(request.body.label)
      const { rows } = await pool.query(
         'UPDATE todo SET label = $1, completed = $2 WHERE id = $3 RETURNING *', [label, Boolean(request.body.completed), id],
      )
      if (!rows[0]) return response.sendStatus(404)
      response.json(rows[0])
   } catch (error) {
      next(error)
   }
})

// DELETE
app.delete('/api/todos/:id', async (request, response, next) => {
   try {
      const result = await pool.query('DELETE FROM todo WHERE id = $1', [requireId(request.params.id)])
      response.sendStatus(result.rowCount ? 204 : 404)
   } catch (error) {
      next(error)
   }
})

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

function requireId(value) {
   const id = Number(value)
   if (!Number.isInteger(id) || id < 1) throw badRequest('Invalid todo id')
   return id
}

function requireLabel(value) {
   if (typeof value !== 'string' || !value.trim()) throw badRequest('Label is required')
   return value.trim()
}

function requireIdempotencyKey(value) {
   if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw badRequest('Valid Idempotency-Key header is required')
   }
   return value
}

function conflict(message) {
   return Object.assign(new Error(message), { status: 409 })
}

function badRequest(message) {
   return Object.assign(new Error(message), { status: 400 })
}
