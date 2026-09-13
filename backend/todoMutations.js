// Run under a transaction. Locking the cursor serializes requests for the same
// client and todo, even when an HTTP timeout leaves an old request running.
export async function applyTodoMutation(tx, mutation) {
   const { clientId, revision, id, action, label, completed } = mutation
   await tx.query(
      `INSERT INTO todo_mutation_cursor (client_id, row_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [clientId, id],
   )
   const { rows: cursors } = await tx.query(
      'SELECT revision, result FROM todo_mutation_cursor WHERE client_id = $1 AND row_id = $2 FOR UPDATE',
      [clientId, id],
   )
   // Also makes retries idempotent: replaying an already committed request cannot
   // overwrite another client's intervening edit or allocate another server version.
   if (BigInt(revision) === BigInt(cursors[0].revision)) return cursors[0].result
   if (BigInt(revision) < BigInt(cursors[0].revision)) {
      const { todo } = cursors[0].result
      // A superseded POST still needs a JSON row, even if the latest request was
      // a DELETE. Its client can then recognize the tombstone and await Electric.
      const status = action === 'create' ? 201 : action === 'delete' ? 204 : todo.deleted ? 404 : 200
      return { status, todo }
   }

   let result
   if (action === 'create') {
      const { rows } = await tx.query(
         `INSERT INTO todo (id, label, completed) VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET id = excluded.id RETURNING *`,
         [id, label, completed],
      )
      result = { status: 201, todo: rows[0] }
   } else if (action === 'update') {
      const { rows } = await tx.query(
         `UPDATE todo SET label = $1, completed = $2, version = nextval('todo_version_seq')
          WHERE id = $3 AND NOT deleted RETURNING *`,
         [label, completed, id],
      )
      result = rows[0]
         ? { status: 200, todo: rows[0] }
         : { status: 404, todo: await ensureTombstone(tx, id) }
   } else if (action === 'delete') {
      const { rows } = await tx.query(
         `INSERT INTO todo (id, label, deleted) VALUES ($1, '', true)
          ON CONFLICT (id) DO UPDATE SET label = '', completed = false,
             deleted = true, version = nextval('todo_version_seq') RETURNING *`,
         [id],
      )
      result = { status: 204, todo: rows[0] }
   } else {
      throw new Error(`Unsupported action: ${action}`)
   }

   // The row change and its receipt commit together, or both roll back.
   await tx.query(
      `UPDATE todo_mutation_cursor SET revision = $3, result = $4::jsonb
       WHERE client_id = $1 AND row_id = $2`,
      [clientId, id, revision, JSON.stringify(result)],
   )
   return result
}

// Preserve an existing row; otherwise create a deletion marker for Electric.
async function ensureTombstone(tx, id) {
   const { rows } = await tx.query(
      `INSERT INTO todo (id, label, deleted) VALUES ($1, '', true)
       ON CONFLICT (id) DO UPDATE SET id = excluded.id RETURNING *`, [id],
   )
   return rows[0]
}

export async function runTodoMutation(pool, mutation) {
   const client = await pool.connect()
   try {
      await client.query('BEGIN')
      const result = await applyTodoMutation(client, mutation)
      await client.query('COMMIT')
      return result
   } catch (error) {
      await client.query('ROLLBACK')
      throw error
   } finally {
      client.release()
   }
}
