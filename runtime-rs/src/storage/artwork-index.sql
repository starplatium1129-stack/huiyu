CREATE TABLE IF NOT EXISTS artwork_read_index (
  id_key TEXT PRIMARY KEY, id_json TEXT NOT NULL, summary TEXT NOT NULL,
  timestamp_json TEXT NOT NULL, numeric_time REAL, revision INTEGER NOT NULL,
  search_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artwork_read_numeric ON artwork_read_index(numeric_time DESC,id_key)
  WHERE numeric_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS artwork_read_legacy ON artwork_read_index(id_key)
  WHERE numeric_time IS NULL;
CREATE TABLE IF NOT EXISTS artwork_read_dirty(id_key TEXT PRIMARY KEY);
INSERT OR IGNORE INTO meta(key,value) SELECT 'artworkRevision',value FROM meta WHERE key='revision';
CREATE TRIGGER IF NOT EXISTS artwork_read_insert AFTER INSERT ON artworks BEGIN
  INSERT OR IGNORE INTO artwork_read_dirty VALUES(NEW.id_key);
  UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='artworkRevision';
END;
CREATE TRIGGER IF NOT EXISTS artwork_read_update AFTER UPDATE ON artworks
WHEN NEW.id_key IS NOT OLD.id_key OR NEW.id_json IS NOT OLD.id_json
  OR NEW.body IS NOT OLD.body OR NEW.revision IS NOT OLD.revision OR NEW.deleted_at IS NOT OLD.deleted_at BEGIN
  INSERT OR IGNORE INTO artwork_read_dirty VALUES(OLD.id_key);
  INSERT OR IGNORE INTO artwork_read_dirty VALUES(NEW.id_key);
  UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='artworkRevision';
END;
CREATE TRIGGER IF NOT EXISTS artwork_read_delete AFTER DELETE ON artworks BEGIN
  INSERT OR IGNORE INTO artwork_read_dirty VALUES(OLD.id_key);
  UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='artworkRevision';
END;
