CREATE TABLE studio_video_batches (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id),
  principal TEXT NOT NULL, fingerprint TEXT NOT NULL
);
CREATE TABLE studio_video_runs (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES studio_video_batches(id),
  project_id TEXT NOT NULL REFERENCES studio_projects(id), shot_id TEXT NOT NULL REFERENCES studio_shots(id),
  principal TEXT NOT NULL, created_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL
);
CREATE UNIQUE INDEX studio_video_live_shot ON studio_video_runs(shot_id) WHERE done=0;
CREATE INDEX studio_video_pending ON studio_video_runs(principal,created_at) WHERE done=0;
CREATE INDEX studio_video_history ON studio_video_runs(project_id,principal,created_at DESC);
