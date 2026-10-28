use super::*;

pub(super) fn ready(connection: &Connection) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_search')
         AND (SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name IN ('catalog_search_insert','catalog_search_delete','catalog_search_update'))=3
         AND (SELECT count(*) FROM sqlite_schema WHERE type='index' AND name IN ('catalog_history_kind','catalog_character_order','catalog_updated'))=3",
        [], |row| row.get(0),
    )?)
}

/// Additive derived indexes. Triggers also cover writes by older runtime binaries.
/// Build and backfill atomically; content records and revision history are untouched.
pub(super) fn ensure(connection: &Connection) -> Result<()> {
    if ready(connection)? {
        return Ok(());
    }
    let transaction = connection.unchecked_transaction()?;
    transaction.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS catalog_search USING fts5(
            search_text, content='content_records', content_rowid='rowid',
            tokenize='trigram case_sensitive 1', detail=none, columnsize=0);
         CREATE TRIGGER IF NOT EXISTS catalog_search_insert AFTER INSERT ON content_records BEGIN
            INSERT INTO catalog_search(rowid,search_text) VALUES(new.rowid,new.search_text);
         END;
         CREATE TRIGGER IF NOT EXISTS catalog_search_delete AFTER DELETE ON content_records BEGIN
            INSERT INTO catalog_search(catalog_search,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
         END;
         CREATE TRIGGER IF NOT EXISTS catalog_search_update AFTER UPDATE OF search_text ON content_records
         WHEN old.search_text IS NOT new.search_text BEGIN
            INSERT INTO catalog_search(catalog_search,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
            INSERT INTO catalog_search(rowid,search_text) VALUES(new.rowid,new.search_text);
         END;
         CREATE INDEX IF NOT EXISTS catalog_history_kind ON content_history(kind,sequence DESC);
         CREATE INDEX IF NOT EXISTS catalog_character_order ON content_records(kind,deleted,character_id,sort_order,id);
         CREATE INDEX IF NOT EXISTS catalog_updated ON content_records(kind,deleted,updated_at DESC,sort_order,id);
         INSERT INTO catalog_search(catalog_search) VALUES('rebuild');"
    )?;
    transaction.commit()?;
    Ok(())
}

/// A few literal trigrams only narrow candidates. The caller still verifies
/// the complete substring, so ordering, punctuation and short queries are unchanged.
pub(super) fn literal_candidates(search: &str) -> Option<String> {
    if search.contains('\0') {
        return None;
    }
    let chars: Vec<_> = search.chars().collect();
    let last = chars.len().checked_sub(3)?;
    let grams: std::collections::BTreeSet<String> = (0..8)
        .map(|index| {
            let start = last * index / 7;
            let gram: String = chars[start..start + 3].iter().collect();
            format!("\"{}\"", gram.replace('"', "\"\""))
        })
        .collect();
    Some(grams.into_iter().collect::<Vec<_>>().join(" AND "))
}
