export async function prepareLocalDB(db) {
   // mutation_queue: row_id is a string, to accomodate all types of primary keys
   // there is at most one mutation per (table, row_id)

   await db.exec(`
      CREATE SEQUENCE IF NOT EXISTS mutation_revision_seq;
      CREATE TABLE IF NOT EXISTS sync_client (
         singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
         id UUID NOT NULL DEFAULT gen_random_uuid()
      );
      INSERT INTO sync_client (singleton) VALUES (true) ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS todo (
         id UUID PRIMARY KEY,
         label TEXT NOT NULL,
         completed BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS mutation_queue (
         seq SERIAL PRIMARY KEY,
         table_name TEXT NOT NULL,
         action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
         row_id TEXT NOT NULL,
         payload JSONB,
         status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
         failure_reason TEXT,
         UNIQUE (table_name, row_id)
      );

      ALTER TABLE mutation_queue ADD COLUMN IF NOT EXISTS acknowledged_version NUMERIC;
      ALTER TABLE mutation_queue ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT nextval('mutation_revision_seq');
   `)
}
