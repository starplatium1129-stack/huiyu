use super::*;
use rusqlite::OpenFlags;
pub(super) fn manifest(c: &Files, directory: &Path, id: &str) -> Result<Value> {
    let value = read_json(directory, "manifest.json")?;
    if value["kind"] != "huiyu-workspace-backup"
        || value["formatVersion"] != 1
        || value["backupId"] != id
        || value["workspaceId"] != c.workspace_id
        || value["schemaVersion"]
            .as_i64()
            .is_none_or(|v| !(1..=3).contains(&v))
        || value["revision"].as_u64().is_none()
        || value["database"]["bytes"].as_u64().is_none()
        || !value["database"]["sha256"]
            .as_str()
            .is_some_and(media::valid_hash)
    {
        return Err(invalid_backup(
            "Backup manifest format or identity is unsupported",
        ));
    }
    let rows = value["media"]
        .as_array()
        .ok_or_else(|| invalid_backup("Invalid backup media manifest"))?;
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let hash = string(row, "hash")?;
        if !media::valid_hash(hash)
            || row["bytes"].as_u64().is_none()
            || row["mime"].as_str().is_none()
            || !seen.insert(hash)
        {
            return Err(invalid_backup("Invalid or duplicate backup media manifest"));
        }
    }
    Ok(value)
}
pub(super) fn verify_snapshot(c: &Files, root: &Path, manifest: &Value) -> Result<()> {
    let database = schema::safe(root, "huiyu.sqlite3")?;
    if digest_file(c, &database)? != manifest["database"] {
        return Err(invalid_backup("Backup database hash mismatch"));
    }
    let identity = read_json(root, "workspace.json")?;
    if identity["workspaceId"] != manifest["workspaceId"]
        || identity["schemaVersion"] != manifest["schemaVersion"]
        || identity["databaseKind"] != "huiyu-workspace"
    {
        return Err(invalid_backup("Backup workspace identity mismatch"));
    }
    for suffix in ["-wal", "-shm"] {
        if schema::safe(root, format!("huiyu.sqlite3{suffix}"))?.exists() {
            return Err(invalid_backup(
                "Backup contains unexpected SQLite side files",
            ));
        }
    }
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let cancel = c.cancel.clone();
    // These full-database scans must observe an abandoned copy request too.
    db.progress_handler(1_000, Some(move || cancel.load(Ordering::Relaxed)))?;
    let verified = (|| -> Result<Vec<&Value>> {
        c.check_cancel()?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        let foreign_keys = db.prepare("PRAGMA foreign_key_check")?.exists([])?;
        if json!(version) != manifest["schemaVersion"] || integrity != "ok" || foreign_keys {
            return Err(invalid_backup(
                "Backup database schema or integrity check failed",
            ));
        }
        for (key, expected) in [
            ("workspaceId", string(manifest, "workspaceId")?.to_string()),
            ("databaseKind", "huiyu-workspace".into()),
            ("schemaVersion", version.to_string()),
            ("revision", manifest["revision"].to_string()),
        ] {
            if db.query_row("SELECT value FROM meta WHERE key=?", [key], |r| {
                r.get::<_, String>(0)
            })? != expected
            {
                return Err(invalid_backup(
                    "Backup database identity or revision mismatch",
                ));
            }
        }
        if db.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
            r.get::<_, i64>(0)
        })? != version
        {
            return Err(invalid_backup("Unknown backup migration version"));
        }
        let mut inventory: Vec<&Value> = manifest["media"].as_array().unwrap().iter().collect();
        inventory.sort_by(|a, b| a["hash"].as_str().cmp(&b["hash"].as_str()));
        let (mut matches, mut count) = (true, 0);
        visit_media_rows(c, &db, |row| {
            matches &= inventory.get(count).is_some_and(|expected| &row == *expected);
            count += 1;
        })?;
        if !matches || count != inventory.len() {
            return Err(invalid_backup(
                "Backup media inventory differs from database",
            ));
        }
        verify_records(c, &db)?;
        Ok(inventory)
    })();
    drop(db);
    // A progress-handler interruption is cancellation only when requested;
    // otherwise preserve the original SQLite or snapshot verification error.
    c.check_cancel()?;
    let inventory = verified?;
    for entry in inventory {
        c.check_cancel()?;
        let hash = string(entry, "hash")?;
        media::verify_checked(
            &c.root,
            &schema::safe(root, object_relative(hash)?)?,
            hash,
            entry["bytes"].as_u64().unwrap(),
            string(entry, "mime")?,
            || c.check_cancel(),
        )?;
    }
    Ok(())
}
fn verify_records(c: &Files, db: &Connection) -> Result<()> {
    let mut original = db.prepare(
        "SELECT 1 FROM media_aliases a JOIN media_refs r ON r.hash=a.hash WHERE a.alias=? AND r.owner_id=?",
    )?;
    let mut membership = db.prepare(
        "SELECT a.id_json FROM project_artworks p JOIN artworks a ON a.id_key=p.artwork_key WHERE project_key=? ORDER BY position",
    )?;
    for table in ["artworks", "projects"] {
        let sql = format!("SELECT id_key,id_json,body FROM {table}");
        let mut stmt = db.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            c.check_cancel()?;
            let key = text_column(row, 0)?;
            let id: Value = serde_json::from_str(text_column(row, 1)?)?;
            let body: Value = serde_json::from_str(text_column(row, 2)?)?;
            if !body.is_object() || body["id"] != id || canonical::entity_key(&id)? != key {
                return Err(invalid_backup("Invalid backup domain record"));
            }
            if table == "artworks" {
                let alias = body["image_id"].as_str().ok_or_else(|| {
                    invalid_backup("Backup artwork original reference is missing")
                })?;
                if !original.exists(params![alias, key])? {
                    return Err(invalid_backup(
                        "Backup artwork original reference is missing",
                    ));
                }
            } else {
                let ids = body["history_ids"].as_array();
                let (mut matches, mut count) = (true, 0);
                for row in membership
                    .query_map([key], |row| Ok(serde_json::from_str::<Value>(text_column(row, 0)?)))?
                {
                    let id = row??;
                    matches &= ids.and_then(|ids| ids.get(count)).is_some_and(|expected| expected == &id);
                    count += 1;
                }
                if !matches || ids.is_none_or(|ids| ids.len() != count) {
                    return Err(invalid_backup(
                        "Backup project order differs from its relationships",
                    ));
                }
            }
        }
    }
    let mut stmt=db.prepare("SELECT t.snapshot,t.project_refs,t.deleted_at,a.id_json,a.deleted_at FROM trash t JOIN artworks a ON a.id_key=t.artwork_key")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        let snapshot: Value = serde_json::from_str(text_column(row, 0)?)?;
        let refs: Value = serde_json::from_str(text_column(row, 1)?)?;
        let id: Value = serde_json::from_str(text_column(row, 3)?)?;
        if !snapshot.is_object()
            || snapshot["id"] != id
            || Some(row.get::<_, i64>(2)?) != row.get::<_, Option<i64>>(4)?
            || refs.as_array().is_none_or(|a| {
                a.iter().any(|r| {
                    r["project_key"].as_str().is_none() || r["position"].as_u64().is_none()
                })
            })
        {
            return Err(invalid_backup("Backup trash snapshot is invalid"));
        }
    }
    Ok(())
}
