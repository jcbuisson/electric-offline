import { PGlite } from '@electric-sql/pglite'

export const db = new PGlite('idb://todo')

export async function prepareLocalDB() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS todo (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      pending BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS mutation_queue (
      seq SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      todo_id INTEGER NOT NULL,
      label TEXT,
      completed BOOLEAN
    );
  `)
}
