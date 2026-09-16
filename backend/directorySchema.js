export async function prepareDirectoryServer(db) {
   await db.query(`
      CREATE SEQUENCE IF NOT EXISTS directory_version_seq;
      CREATE TABLE IF NOT EXISTS app_user (
         id UUID PRIMARY KEY, firstname TEXT NOT NULL DEFAULT '', lastname TEXT NOT NULL DEFAULT '',
         email TEXT NOT NULL DEFAULT '', deleted BOOLEAN NOT NULL DEFAULT false,
         version BIGINT NOT NULL DEFAULT nextval('directory_version_seq')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS app_user_email ON app_user (lower(email)) WHERE NOT deleted;
      CREATE TABLE IF NOT EXISTS app_group (
         id UUID PRIMARY KEY, name TEXT NOT NULL DEFAULT '', deleted BOOLEAN NOT NULL DEFAULT false,
         version BIGINT NOT NULL DEFAULT nextval('directory_version_seq')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS app_group_name ON app_group (lower(name)) WHERE NOT deleted;
      CREATE TABLE IF NOT EXISTS user_group_relation (
         id UUID PRIMARY KEY, user_uid UUID REFERENCES app_user(id), group_uid UUID REFERENCES app_group(id),
         deleted BOOLEAN NOT NULL DEFAULT false,
         version BIGINT NOT NULL DEFAULT nextval('directory_version_seq'),
         CHECK (deleted OR (user_uid IS NOT NULL AND group_uid IS NOT NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS membership_pair ON user_group_relation (user_uid, group_uid) WHERE NOT deleted;
      CREATE TABLE IF NOT EXISTS directory_mutation_cursor (
         client_id UUID NOT NULL, table_name TEXT NOT NULL, row_id UUID NOT NULL,
         revision BIGINT NOT NULL DEFAULT 0, result JSONB,
         PRIMARY KEY (client_id, table_name, row_id)
      );
   `)
}
