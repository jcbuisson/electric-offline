import { directoryModel } from '../shared/directoryModels.js'

// Like todo_mutation_cursor, receipts serialize and deduplicate each client's
// requests. Server versions are separate: they acknowledge Electric delivery.
export async function applyDirectoryMutation(tx, { clientId, revision, table, id, action, values }) {
   const { fields } = directoryModel(table)
   await tx.query(`INSERT INTO directory_mutation_cursor (client_id, table_name, row_id)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [clientId, table, id])
   const { rows: [cursor] } = await tx.query(`SELECT * FROM directory_mutation_cursor
      WHERE client_id=$1 AND table_name=$2 AND row_id=$3 FOR UPDATE`, [clientId, table, id])
   if (BigInt(revision) <= BigInt(cursor.revision)) return cursor.result

   let row
   if (action === 'delete') {
      row = await tombstone(tx, table, id)
      // Version the cascading deletions too. Physical CASCADE would remove the
      // acknowledgement that an offline client needs to clear its queue.
      if (table !== 'user_group_relation') {
         const parentField = table === 'app_user' ? 'user_uid' : 'group_uid'
         await tx.query(`UPDATE user_group_relation SET deleted=true, version=nextval('directory_version_seq')
            WHERE ${parentField}=$1 AND NOT deleted`, [id])
      }
   } else {
      let parentDeleted = false
      if (table === 'user_group_relation') {
         // Lock parents before inserting: a concurrent parent delete either waits
         // and cascades this membership, or wins and prevents its resurrection.
         for (const [parent, field] of [['app_user', 'user_uid'], ['app_group', 'group_uid']]) {
            const { rows: [value] } = await tx.query(`SELECT deleted FROM ${parent} WHERE id=$1 FOR UPDATE`, [values[field]])
            if (!value) throw Object.assign(new Error('Sync the user and group before adding membership'), { status: 409 })
            parentDeleted ||= value.deleted
         }
      }
      if (parentDeleted) {
         row = await tombstone(tx, table, id)
      } else {
         const params = [id, ...fields.map(field => values[field])]
         const assignments = fields.map((field, index) => `${field}=$${index + 2}`).join(', ')
         if (table === 'user_group_relation') {
            // Memberships can be toggled off and on, with a stable ID per pair.
            const result = await tx.query(`INSERT INTO ${table} (id, ${fields.join(',')})
               VALUES (${params.map((_, i) => `$${i+1}`).join(',')})
               ON CONFLICT (id) DO UPDATE SET ${assignments}, deleted=false,
                  version=nextval('directory_version_seq') RETURNING *`, params)
            row = result.rows[0]
         } else if (action === 'create') {
            const result = await tx.query(`INSERT INTO ${table} (id, ${fields.join(',')})
               VALUES (${params.map((_, i) => `$${i+1}`).join(',')})
               ON CONFLICT (id) DO UPDATE SET id=excluded.id RETURNING *`, params)
            row = result.rows[0]
         } else {
            const result = await tx.query(`UPDATE ${table} SET ${assignments}, version=nextval('directory_version_seq')
               WHERE id=$1 AND NOT deleted RETURNING *`, params)
            row = result.rows[0] ?? await tombstone(tx, table, id)
         }
      }
   }
   await tx.query(`UPDATE directory_mutation_cursor SET revision=$4, result=$5::jsonb
      WHERE client_id=$1 AND table_name=$2 AND row_id=$3`, [clientId, table, id, revision, JSON.stringify(row)])
   return row
}

async function tombstone(tx, table, id) {
   const { rows: [row] } = await tx.query(`INSERT INTO ${table} (id, deleted) VALUES ($1,true)
      ON CONFLICT (id) DO UPDATE SET deleted=true, version=nextval('directory_version_seq') RETURNING *`, [id])
   return row
}

export async function runDirectoryMutation(pool, mutation) {
   const connection = await pool.connect()
   try {
      await connection.query('BEGIN')
      const result = await applyDirectoryMutation(connection, mutation)
      await connection.query('COMMIT')
      return result
   } catch (error) {
      await connection.query('ROLLBACK')
      if (error.code === '23505') throw Object.assign(new Error('That email, group name, or membership already exists'), { status: 409 })
      throw error
   } finally {
      connection.release()
   }
}
