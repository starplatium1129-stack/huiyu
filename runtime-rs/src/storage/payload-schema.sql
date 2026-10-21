CREATE TABLE image_batch_sources (
  id TEXT PRIMARY KEY REFERENCES image_batch_plans(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL
);
CREATE TABLE image_batch_inputs (
  batch_id TEXT NOT NULL REFERENCES image_batch_plans(id) ON DELETE CASCADE,
  job_index INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(batch_id,job_index)
);
CREATE TABLE task_payloads (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  checkpoint_shots INTEGER,
  token TEXT NOT NULL
);
