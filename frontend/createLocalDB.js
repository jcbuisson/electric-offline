import { PGlite } from '@electric-sql/pglite'

export const db = new PGlite('idb://todo')

export async function prepareLocalDB() {
   // mutation_queue: row_id is a string, to accomodate all types of primary keys
   // there is at most one mutation per (table, row_id)

   await db.exec(`
      CREATE TABLE IF NOT EXISTS todo (
         id INTEGER PRIMARY KEY,
         label TEXT NOT NULL,
         completed BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS mutation_queue (
         seq SERIAL PRIMARY KEY,
         idempotency_key UUID NOT NULL UNIQUE,
         table_name TEXT NOT NULL,
         action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
         row_id TEXT NOT NULL,
         payload JSONB,
         request_payload JSONB,
         status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
         failure_reason TEXT,
         UNIQUE (table_name, row_id)
      );
   `)
}
