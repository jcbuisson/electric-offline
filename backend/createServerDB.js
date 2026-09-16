import pg from 'pg'
import { prepareDirectoryServer } from './directorySchema.js'

const { Pool } = pg
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to your PostgreSQL connection string')
export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export async function createServerDB() {
   await prepareDirectoryServer(pool)
}
