import { PGlite } from '@electric-sql/pglite'

export const db = new PGlite('idb://todo')

export async function prepareLocalDB() {
   // NOTE that row_id is a string, to accomodate all types of primary keys
   await db.exec(`
      CREATE TABLE IF NOT EXISTS todo (
         id INTEGER PRIMARY KEY,
         label TEXT NOT NULL,
         completed BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS mutation_queue (
         seq SERIAL PRIMARY KEY,
         table_name TEXT NOT NULL,
         action TEXT NOT NULL,
         row_id TEXT NOT NULL,
         payload JSONB
      );
   `)
}
