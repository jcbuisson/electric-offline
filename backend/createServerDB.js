import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({
   connectionString: process.env.DATABASE_URL || 'postgresql://localhost/todoDB',
})

export async function createServerDB() {
   await pool.query(`
      CREATE SEQUENCE IF NOT EXISTS todo_version_seq;

      -- Keep the latest request/result per client and todo, including deleted todos.
      CREATE TABLE IF NOT EXISTS todo_mutation_cursor (
         client_id UUID NOT NULL,
         row_id UUID NOT NULL,
         revision BIGINT NOT NULL DEFAULT 0,
         result JSONB,
         PRIMARY KEY (client_id, row_id)
      );

      CREATE TABLE IF NOT EXISTS todo (
         id UUID PRIMARY KEY,
         label TEXT NOT NULL,
         completed BOOLEAN NOT NULL DEFAULT FALSE
      );

      ALTER TABLE todo ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT nextval('todo_version_seq');
      ALTER TABLE todo ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false;
   `)
}
