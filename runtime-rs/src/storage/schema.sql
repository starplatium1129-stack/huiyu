
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE artworks(id_key TEXT PRIMARY KEY, id_json TEXT NOT NULL, body TEXT NOT NULL,
  revision INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE projects(id_key TEXT PRIMARY KEY, id_json TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE project_artworks(project_key TEXT NOT NULL REFERENCES projects(id_key) ON DELETE CASCADE,
  artwork_key TEXT NOT NULL REFERENCES artworks(id_key), position INTEGER NOT NULL,
  PRIMARY KEY(project_key,artwork_key), UNIQUE(project_key,position));
CREATE TABLE trash(artwork_key TEXT PRIMARY KEY REFERENCES artworks(id_key) ON DELETE CASCADE,
  deleted_at INTEGER NOT NULL, snapshot TEXT NOT NULL, project_refs TEXT NOT NULL);
CREATE TABLE media_objects(hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, mime TEXT NOT NULL);
CREATE TABLE media_aliases(alias TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES media_objects(hash));
CREATE TABLE media_refs(owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
  hash TEXT NOT NULL REFERENCES media_objects(hash), PRIMARY KEY(owner_kind,owner_id,hash));
CREATE TABLE operations(op_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL, kind TEXT NOT NULL,
  operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
  input_json TEXT NOT NULL, receipt_json TEXT, revision INTEGER,
  UNIQUE(principal_id,kind,operation_id), UNIQUE(principal_id,operation_id));
CREATE TABLE leases(id TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT,
  operation_key TEXT REFERENCES operations(op_key), created_at INTEGER NOT NULL);
CREATE INDEX leases_hash ON leases(hash);
PRAGMA user_version=1;
