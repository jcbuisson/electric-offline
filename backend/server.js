import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServerDB, pool } from './createServerDB.js'
import { runTodoMutation } from './todoMutations.js'

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


app.post('/api/todos', handleMutation('create'))
app.put('/api/todos/:id', handleMutation('update'))
app.delete('/api/todos/:id', handleMutation('delete'))

function handleMutation(action) {
   return async (request, response, next) => {
      try {
         const result = await runTodoMutation(pool, {
            clientId: requireId(request.get('X-Sync-Client')),
            revision: requireRevision(request.get('X-Mutation-Revision')),
            id: requireId(action === 'create' ? request.body.id : request.params.id),
            action,
            label: action === 'delete' ? undefined : requireLabel(request.body.label),
            completed: Boolean(request.body?.completed),
         })
         response.set('X-Sync-Version', String(result.todo.version))
         if (result.status === 204 || result.status === 404) return response.sendStatus(result.status)
         response.status(result.status).json(result.todo)
      } catch (error) {
         next(error)
      }
   }
}


function requireRevision(value) {
   if (!value || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
      throw badRequest('Invalid mutation revision')
   }
   return value
}

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
