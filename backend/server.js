import express from 'express'
import pg from 'pg'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { Pool } = pg
const app = express()
const port = Number(process.env.PORT || 3001)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/todoDB',
})

app.use(express.json())

app.post('/api/todos', async (request, response, next) => {
  try {
    const label = requireLabel(request.body.label)
    const { rows } = await pool.query(
      'INSERT INTO todo (label, completed) VALUES ($1, $2) RETURNING *',
      [label, Boolean(request.body.completed)],
    )
    response.status(201).json(rows[0])
  } catch (error) {
    next(error)
  }
})

app.put('/api/todos/:id', async (request, response, next) => {
  try {
    const id = requireId(request.params.id)
    const label = requireLabel(request.body.label)
    const { rows } = await pool.query(
      'UPDATE todo SET label = $1, completed = $2 WHERE id = $3 RETURNING *',
      [label, Boolean(request.body.completed), id],
    )
    if (!rows[0]) return response.sendStatus(404)
    response.json(rows[0])
  } catch (error) {
    next(error)
  }
})

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

app.listen(port, () => console.log(`Todo API listening on http://localhost:${port}`))

function requireId(value) {
  const id = Number(value)
  if (!Number.isInteger(id) || id < 1) throw badRequest('Invalid todo id')
  return id
}

function requireLabel(value) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('Label is required')
  return value.trim()
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}
