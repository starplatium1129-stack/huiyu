/** Applied by the single workspace writer as schema version 3. */
export const TASK_SCHEMA_SQL = `
CREATE TABLE tasks(task_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, request_key TEXT NOT NULL,
  provider TEXT NOT NULL, upstream_settled INTEGER NOT NULL, record_json TEXT NOT NULL,
  UNIQUE(principal_id,request_key));
CREATE INDEX tasks_active ON tasks(provider,upstream_settled);
CREATE TABLE task_cancel_intents(principal_id TEXT NOT NULL, request_key TEXT NOT NULL,
  requested_at INTEGER NOT NULL, PRIMARY KEY(principal_id,request_key));
CREATE TABLE task_outputs(task_id TEXT NOT NULL REFERENCES tasks(task_id), output_index INTEGER NOT NULL,
  media_json TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,output_index));
CREATE TABLE task_inputs(task_id TEXT NOT NULL REFERENCES tasks(task_id), name TEXT NOT NULL,
  media_json TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,name));
`;
