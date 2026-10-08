use super::*;
use rusqlite::{OptionalExtension, params};
use std::{collections::BTreeSet, fmt::Write};

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(include_str!("artwork-search.sql"))?;
    let version = db
        .query_row(
            "SELECT value FROM meta WHERE key='artworkSearchIndexVersion'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if version.as_deref() != Some("2") {
        db.execute(
            "INSERT OR IGNORE INTO artwork_search_dirty SELECT rowid FROM artwork_read_index",
            [],
        )?;
        db.execute(
            "INSERT OR REPLACE INTO meta VALUES('artworkSearchIndexVersion','2')",
            [],
        )?;
    }
    Ok(())
}

fn anchor(terms: &[&str]) -> (&'static str, String) {
    if let Some(term) = terms
        .iter()
        .filter(|term| !term.contains('\0') && term.chars().nth(2).is_some())
        .max_by_key(|term| term.len())
    {
        // One literal trigram is a candidate filter, never the final match.
        // No stemming, folding, wildcard syntax or removal of diacritics.
        return (
            "artwork_search_fts",
            format!(
                "\"{}\"",
                term.chars()
                    .take(3)
                    .collect::<String>()
                    .replace('"', "\"\"")
            ),
        );
    }
    // Character presence covers short CJK queries without changing substring
    // order/repetition semantics. Keep a bounded subset of necessary characters.
    let query = terms
        .iter()
        .flat_map(|term| term.chars())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .rev()
        .take(16)
        .map(|ch| format!("\"u{:x}\"", ch as u32))
        .collect::<Vec<_>>()
        .join(" AND ");
    ("artwork_search_chars", query)
}
pub(super) fn needs_index(command: &Value) -> bool {
    command["terms"].as_array().is_some_and(|terms| {
        terms
            .iter()
            .any(|term| term.as_str().is_some_and(|term| !term.is_empty()))
    })
}

fn character_tokens(text: &str) -> String {
    let mut ascii = [false; 128];
    let mut other = BTreeSet::new();
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii[ch as usize] = true;
        } else {
            other.insert(ch);
        }
    }
    let mut tokens = String::new();
    for ch in (0..128)
        .filter(|index| ascii[*index])
        .map(|index| char::from(index as u8))
        .chain(other)
    {
        write!(&mut tokens, "u{:x} ", ch as u32).unwrap();
    }
    tokens
}

pub(super) fn ready(c: &Context) -> Result<bool> {
    Ok(!c
        .db
        .prepare_cached("SELECT 1 FROM artwork_search_dirty LIMIT 1")?
        .exists([])?)
}

pub(super) fn refresh_small(c: &Context) -> Result<bool> {
    let pending: i64 = c.db.query_row(
        "SELECT count(*) FROM (SELECT id FROM artwork_search_dirty LIMIT 129)",
        [],
        |row| row.get(0),
    )?;
    if (1..=128).contains(&pending) {
        refresh_chunk(c)
    } else {
        Ok(false)
    }
}

pub(super) fn warm(storage: &Storage) {
    if storage
        .search_warming
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let storage = storage.clone();
    tokio::spawn(async move {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        loop {
            // Do not keep a workspace alive solely to build an unused cache.
            if storage.sender.strong_count() == 1 {
                storage.search_warming.store(false, Ordering::Release);
                break;
            }
            let (reply, result) = oneshot::channel();
            if storage
                .sender
                .send(Work::WarmArtworkSearch(
                    cancel.0.clone(),
                    storage.search_warming.clone(),
                    reply,
                ))
                .await
                .is_err()
            {
                storage.search_warming.store(false, Ordering::Release);
                break;
            }
            match result.await {
                Ok(Ok(true)) => (),
                Err(_) => {
                    storage.search_warming.store(false, Ordering::Release);
                    break;
                }
                _ => break,
            }
        }
    });
}

pub(super) fn refresh_chunk(c: &Context) -> Result<bool> {
    c.check_cancel()?;
    let ids =
        c.db.prepare_cached("SELECT id FROM artwork_search_dirty ORDER BY id LIMIT 128")?
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.is_empty() {
        return Ok(false);
    }
    c.writer()?;
    let transaction = c.db.unchecked_transaction()?;
    let mut source =
        c.db.prepare_cached("SELECT search_text FROM artwork_read_index WHERE rowid=?")?;
    let mut insert = c.db.prepare_cached(
        "INSERT OR REPLACE INTO artwork_search_fts(rowid,search_text) VALUES(?1,?2)",
    )?;
    let mut characters = c.db.prepare_cached(
        "INSERT OR REPLACE INTO artwork_search_chars(rowid,tokens) VALUES(?1,?2)",
    )?;
    for id in ids {
        c.check_cancel()?;
        if let Some(text) = source
            .query_row([id], |row| row.get::<_, String>(0))
            .optional()?
        {
            characters.execute(params![id, character_tokens(&text)])?;
            insert.execute(params![id, text])?;
        } else {
            c.db.execute("DELETE FROM artwork_search_fts WHERE rowid=?", [id])?;
            c.db.execute("DELETE FROM artwork_search_chars WHERE rowid=?", [id])?;
        }
        c.db.execute("DELETE FROM artwork_search_dirty WHERE id=?", [id])?;
    }
    drop(insert);
    drop(characters);
    drop(source);
    transaction.commit()?;
    Ok(true)
}

fn selective(c: &Context, pattern: &(&'static str, String)) -> Result<bool> {
    let table = pattern.0;
    let matched: i64 =
        c.db.prepare_cached(&format!(
            "SELECT count(*) FROM {table} WHERE {table} MATCH ?"
        ))?
        .query_row([&pattern.1], |row| row.get(0))?;
    if matched == 0 {
        return Ok(true);
    }
    let total: i64 =
        c.db.prepare_cached("SELECT count(*) FROM artwork_read_index")?
            .query_row([], |row| row.get(0))?;
    // A broad candidate set only adds work. Continue the already-open ordered
    // scan instead of rescanning its prefix or materializing most row IDs.
    Ok(matched <= total / 2)
}

// None requests the indexed pass after a small latest/legacy prefix misses.
// Keep numeric order supplied by its index so common anchors cannot sort and
// materialize the full text corpus. Final matching still uses Rust substring rules.
fn rows(
    c: &Context,
    terms: &[&str],
    pattern: Option<&(&'static str, String)>,
    numeric: bool,
    cursor: &str,
    indexed: bool,
) -> Result<Option<(Vec<Value>, Value)>> {
    let (index, filter, order, limit) = if numeric {
        (
            "artwork_read_numeric",
            "numeric_time IS NOT NULL",
            "numeric_time DESC,id_key",
            5,
        )
    } else {
        ("artwork_read_legacy", "numeric_time IS NULL", "id_key", 200)
    };
    let restrict = if indexed {
        let table = pattern.unwrap().0;
        format!("AND rowid IN(SELECT rowid FROM {table} WHERE {table} MATCH ?2)")
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT search_text,summary,id_key FROM artwork_read_index INDEXED BY {index} WHERE {filter} AND id_key>?1 {restrict} ORDER BY {order}"
    );
    let mut statement = c.db.prepare_cached(&sql)?;
    let mut rows = if indexed {
        statement.query(params![cursor, pattern.unwrap().1])?
    } else {
        statement.query([cursor])?
    };
    let mut items = Vec::new();
    let mut last = String::new();
    let mut checked = 0;
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        checked += 1;
        let text = text_column(row, 0)?;
        if terms.iter().all(|term| text.contains(term)) {
            if items.len() == limit {
                return Ok(Some((items, last.into())));
            }
            items.push(serde_json::from_str::<Value>(text_column(row, 1)?)?);
            last = row.get(2)?;
            if numeric && items.len() == limit {
                return Ok(Some((items, Value::Null)));
            }
        }
        if !indexed
            && checked == 32
            && let Some(pattern) = pattern
            && selective(c, pattern)?
        {
            return Ok(None);
        }
    }
    Ok(Some((items, Value::Null)))
}

pub(super) fn read(c: &Context, command: &Value) -> Result<Value> {
    let terms = command["terms"]
        .as_array()
        .ok_or_else(|| invalid("Search terms must be an array"))?;
    let terms = terms
        .iter()
        .map(|v| {
            v.as_str()
                .ok_or_else(|| invalid("Search terms must be strings"))
        })
        .collect::<Result<Vec<_>>>()?;
    let cursor = command
        .get("cursor")
        .map(|v| v.as_str().ok_or_else(|| invalid("Invalid search cursor")))
        .transpose()?;
    if terms.is_empty() || terms.iter().any(|term| term.is_empty()) {
        return Err(invalid("Search terms must not be empty"));
    }
    artwork_index::refresh(c)?;
    // First search uses the exact linear path immediately. The caller warms
    // the optional trigram cache in bounded FIFO work after publishing it.
    let pattern = if ready(c)? {
        Some(anchor(&terms))
    } else {
        None
    };
    let transaction = c.db.unchecked_transaction()?;
    let version = artwork_index::revision(c)?;
    let select = |numeric, cursor| -> Result<(Vec<Value>, Value)> {
        match rows(c, &terms, pattern.as_ref(), numeric, cursor, false)? {
            Some(result) => Ok(result),
            None => Ok(rows(c, &terms, pattern.as_ref(), numeric, cursor, true)?.unwrap()),
        }
    };
    let mut items = if cursor.is_none() {
        select(true, "")?.0
    } else {
        Vec::new()
    };
    let (legacy, next) = select(false, cursor.unwrap_or(""))?;
    items.extend(legacy);
    c.check_cancel()?;
    transaction.commit()?;
    let mut result = json!({"items":null,"artworkRevision":version,"nextCursor":next});
    result["items"] = items.into();
    Ok(result)
}
