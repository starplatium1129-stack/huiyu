use super::*;
use rusqlite::params;

// Derived read data. Triggers cover all artwork writers, including migration,
// trash, batch edits and older clients, within their original transaction.
pub(super) fn initialize(db: &Connection) -> Result<()> {
    let transaction = db.unchecked_transaction()?;
    db.execute_batch(include_str!("artwork-index.sql"))?;
    let initialized = db
        .prepare("SELECT 1 FROM meta WHERE key='artworkReadIndexVersion' AND value='1'")?
        .exists([])?;
    if !initialized {
        db.execute_batch(
            "DELETE FROM artwork_read_index;
            INSERT OR IGNORE INTO artwork_read_dirty SELECT id_key FROM artworks;
            INSERT OR REPLACE INTO meta VALUES('artworkReadIndexVersion','1');",
        )?;
    }
    super::artwork_search::initialize(db)?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn revision(c: &Context) -> Result<i64> {
    Ok(c.db.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key='artworkRevision'",
        [],
        |row| row.get(0),
    )?)
}

pub(super) async fn request(storage: &Storage, command: Value, principal: &str) -> Result<Value> {
    let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
    loop {
        let (reply, result) = oneshot::channel();
        storage
            .sender
            .send(Work::ArtworkRead(
                command.clone(),
                principal.into(),
                cancel.0.clone(),
                reply,
            ))
            .await
            .map_err(|_| unavailable())?;
        if let Some((value, warm_search)) = result.await.map_err(|_| unavailable())?? {
            if warm_search {
                artwork_search::warm(storage);
            }
            return Ok(value);
        }
    }
}

pub(super) fn refresh(c: &Context) -> Result<()> {
    while refresh_chunk(c)? {}
    Ok(())
}

pub(super) fn refresh_chunk(c: &Context) -> Result<bool> {
    // Bound transient memory and retain finished chunks when first-time indexing
    // is cancelled. Derived writes never change workspace/artwork revisions.
    c.check_cancel()?;
    let keys =
        c.db.prepare_cached("SELECT id_key FROM artwork_read_dirty ORDER BY id_key LIMIT 128")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    if keys.is_empty() {
        return Ok(false);
    }
    c.writer()?;
    let transaction = c.db.unchecked_transaction()?;
    let mut source = c.db.prepare_cached(
            "SELECT id_json,json_object('id',json(id_json),'title',body -> '$.title',
                'sceneTitle',body -> '$.sceneTitle','scene',body -> '$.scene',
                'timestamp',body -> '$.timestamp','size',body -> '$.size'),revision,body -> '$.timestamp',
             CASE WHEN json_type(body,'$.title')='text' THEN json_extract(body,'$.title') END,
             CASE WHEN json_type(body,'$.sceneTitle')='text' THEN json_extract(body,'$.sceneTitle') END,
             CASE WHEN json_type(body,'$.scene')='text' THEN json_extract(body,'$.scene') END,
             CASE WHEN json_type(body,'$.character')='text' THEN json_extract(body,'$.character') END,
             CASE WHEN json_type(body,'$.characterId')='text' THEN json_extract(body,'$.characterId') END,
             CASE WHEN json_type(body,'$.story')='text' THEN json_extract(body,'$.story') END,
             CASE WHEN json_type(body,'$.project')='text' THEN json_extract(body,'$.project') END,
             CASE WHEN json_type(body,'$.prompt')='text' THEN json_extract(body,'$.prompt') END
             FROM artworks WHERE id_key=? AND deleted_at IS NULL",
        )?;
    let mut insert = c.db.prepare_cached(
        "INSERT INTO artwork_read_index VALUES(?1,?2,?3,?4,?5,?6,?7)
            ON CONFLICT(id_key) DO UPDATE SET id_json=excluded.id_json,summary=excluded.summary,
            timestamp_json=excluded.timestamp_json,numeric_time=excluded.numeric_time,
            revision=excluded.revision,search_text=excluded.search_text",
    )?;
    for key in keys {
        c.check_cancel()?;
        let mut rows = source.query([&key])?;
        if let Some(row) = rows.next()? {
            // Project before decoding: legacy inline images and recipes stay
            // inside SQLite. Borrow text until its normalized copy is ready.
            let timestamp = row
                .get::<_, Option<String>>(3)?
                .unwrap_or_else(|| "null".into());
            let numeric = serde_json::from_str::<Value>(&timestamp)?
                .as_f64()
                .filter(|v| v.is_finite());
            let mut fields = [""; 8];
            for (index, field) in fields.iter_mut().enumerate() {
                if !matches!(row.get_ref(index + 4)?, rusqlite::types::ValueRef::Null) {
                    *field = text_column(row, index + 4)?;
                }
            }
            let text = fields
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            insert.execute(params![
                key,
                text_column(row, 0)?,
                text_column(row, 1)?,
                timestamp,
                numeric,
                row.get::<_, i64>(2)?,
                text
            ])?;
        } else {
            c.db.execute("DELETE FROM artwork_read_index WHERE id_key=?", [&key])?;
        }
        drop(rows);
        c.db.execute("DELETE FROM artwork_read_dirty WHERE id_key=?", [&key])?;
    }
    drop(insert);
    drop(source);
    transaction.commit()?;
    Ok(true)
}
