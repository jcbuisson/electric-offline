export async function prepareDirectoryLocal(db) {
   // Parent shapes can arrive independently of membership shapes. Join against
   // visible parents when reading instead of imposing cross-stream foreign keys.
   await db.exec(`
      CREATE TABLE IF NOT EXISTS app_user (id UUID PRIMARY KEY, firstname TEXT NOT NULL, lastname TEXT NOT NULL, email TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_group (id UUID PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_group_relation (id UUID PRIMARY KEY, user_uid UUID NOT NULL, group_uid UUID NOT NULL);
   `)
}
