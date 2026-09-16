import express from 'express'
import { directoryModel, directoryValues, requireUUID, membershipId } from '../shared/directoryModels.js'
import { runDirectoryMutation } from './directoryMutations.js'

export function directoryRouter(pool) {
   const router = express.Router()
   for (const [method, action] of [['post','create'], ['put','update'], ['delete','delete']]) {
      router[method]('/:table/:id', async (request, response, next) => {
         try {
            const { table, id } = request.params
            directoryModel(table); requireUUID(id)
            const clientId = requireUUID(request.get('X-Sync-Client'))
            const revision = request.get('X-Mutation-Revision')
            if (!revision || !/^[1-9][0-9]{0,18}$/.test(revision) || BigInt(revision) > 9223372036854775807n) {
               throw Object.assign(new Error('Invalid mutation revision'), { status: 400 })
            }
            const values = action === 'delete' ? undefined : directoryValues(table, request.body)
            if (table === 'user_group_relation' && values && id !== await membershipId(values.user_uid, values.group_uid)) {
               throw Object.assign(new Error('Membership ID does not match its user and group'), { status: 400 })
            }
            const row = await runDirectoryMutation(pool, { clientId, revision, table, id, action, values })
            response.set('X-Sync-Version', String(row.version)).json(row)
         } catch (error) { next(error) }
      })
   }
   return router
}
