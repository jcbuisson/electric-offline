import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({
   connectionString: process.env.DATABASE_URL || 'postgresql://localhost/todoDB',
})

export async function createServerDB() {
   await pool.query(`
      CREATE TABLE IF NOT EXISTS todo (
         id UUID PRIMARY KEY,
         label TEXT NOT NULL,
         completed BOOLEAN NOT NULL DEFAULT FALSE
      );
   `)
}
