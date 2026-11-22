-- Phase 2 produced immutable clips before shots had an explicit timeline selection.
UPDATE studio_shots SET body = json_set(body,
  '$.audioVersionId', NULL,
  '$.currentClipVersionId', (
    SELECT v.id FROM studio_video_runs r
    JOIN studio_versions v ON v.id=json_extract(r.body,'$.clipVersionId')
    WHERE r.shot_id=studio_shots.id AND r.project_id=studio_shots.project_id
      AND json_extract(r.body,'$.status')='succeeded'
    ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1
  ));
CREATE TABLE studio_exports (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES studio_projects(id),
  principal TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL
);
CREATE INDEX studio_export_pending ON studio_exports(principal,created_at) WHERE done=0;
CREATE INDEX studio_export_history ON studio_exports(project_id,principal,created_at DESC);
