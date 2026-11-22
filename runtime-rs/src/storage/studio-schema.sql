CREATE TABLE studio_projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE studio_assets(id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE studio_versions(
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES studio_assets(id),
  number INTEGER NOT NULL CHECK(number > 0),
  media_alias TEXT NOT NULL REFERENCES media_aliases(alias),
  body TEXT NOT NULL,
  UNIQUE(asset_id, number)
);
CREATE TABLE studio_shots(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES studio_projects(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  first_version TEXT REFERENCES studio_versions(id),
  last_version TEXT REFERENCES studio_versions(id),
  body TEXT NOT NULL,
  UNIQUE(project_id, position)
);
