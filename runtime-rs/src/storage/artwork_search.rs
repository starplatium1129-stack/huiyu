use super::*;
use rusqlite::{OptionalExtension, params};
use std::{collections::BTreeSet, fmt::Write};

mod read;
pub(super) use read::{Search, Step};

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
        // Keep the old anchor, then intersect literal prefixes/suffixes from
        // other terms. A common prefix alone can overflow the 128-row probe
        // and force a full scan even when the complete query is selective.
        // Each token stays exactly three Unicode characters for detail=none;
        // all are necessary conditions, with contains still the final match.
        let mut trigrams = BTreeSet::from([term.chars().take(3).collect::<String>()]);
        for term in terms
            .iter()
            .filter(|term| !term.contains('\0') && term.chars().nth(2).is_some())
        {
            let suffix = term.chars().rev().take(3).collect::<Vec<_>>();
            for trigram in [
                term.chars().take(3).collect::<String>(),
                suffix.into_iter().rev().collect(),
            ] {
                trigrams.insert(trigram);
                if trigrams.len() == 16 {
                    break;
                }
            }
            if trigrams.len() == 16 {
                break;
            }
        }
        return (
            "artwork_search_fts",
            trigrams
                .into_iter()
                .map(|trigram| format!("\"{}\"", trigram.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND "),
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
