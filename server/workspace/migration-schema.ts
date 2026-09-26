export const MIGRATION_SCHEMA_VERSION = 2;
export const MIGRATION_SCHEMA_SQL = `
CREATE TABLE migration_sessions(migration_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, envelope TEXT NOT NULL, state TEXT NOT NULL, report TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE migration_items(migration_id TEXT NOT NULL REFERENCES migration_sessions(migration_id),
  item_id TEXT NOT NULL, sha256 TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(migration_id,item_id));
CREATE TABLE migration_media(migration_id TEXT NOT NULL REFERENCES migration_sessions(migration_id),
  alias TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(migration_id,alias));
CREATE TABLE profile_records(domain TEXT NOT NULL CHECK(domain IN ('settings','chat','draft')),
  record_key TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(domain,record_key));
`;
