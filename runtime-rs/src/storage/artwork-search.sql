CREATE VIRTUAL TABLE IF NOT EXISTS artwork_search_fts USING fts5(
  search_text,content='',contentless_delete=1,tokenize='trigram case_sensitive 1',detail=none
);
CREATE VIRTUAL TABLE IF NOT EXISTS artwork_search_chars USING fts5(
  tokens,content='',contentless_delete=1,tokenize='ascii',detail=none
);
CREATE TABLE IF NOT EXISTS artwork_search_dirty(id INTEGER PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS artwork_search_insert AFTER INSERT ON artwork_read_index BEGIN
  INSERT OR IGNORE INTO artwork_search_dirty VALUES(NEW.rowid);
END;
CREATE TRIGGER IF NOT EXISTS artwork_search_update AFTER UPDATE ON artwork_read_index
WHEN NEW.search_text IS NOT OLD.search_text BEGIN
  INSERT OR IGNORE INTO artwork_search_dirty VALUES(NEW.rowid);
END;
CREATE TRIGGER IF NOT EXISTS artwork_search_delete AFTER DELETE ON artwork_read_index BEGIN
  INSERT OR IGNORE INTO artwork_search_dirty VALUES(OLD.rowid);
END;
