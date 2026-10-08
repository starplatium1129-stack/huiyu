use super::*;
use canonical::{entity_key, stringify};
use rusqlite::{OptionalExtension, Row, params};
use std::collections::{BTreeSet, HashSet};
pub(super) const RETENTION: i64 = 30 * 24 * 60 * 60 * 1000;
#[cfg(test)]
mod tests;
fn json_column(row: &Row<'_>, column: usize) -> rusqlite::Result<Value> {
    serde_json::from_str(text_column(row, column)?).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e))
    })
}
pub(super) fn decode_artwork(row: &Row<'_>) -> rusqlite::Result<Value> {
    // json! serializes Value expressions by reference, copying the whole body.
    // Move decoded bodies so legacy inline images/recipes are allocated once.
    let mut record = json!({"id":null,"body":null,"revision":row.get::<_,i64>(2)?,"deletedAt":row.get::<_,Option<i64>>(3)?});
    record["id"] = json_column(row, 0)?;
    record["body"] = json_column(row, 1)?;
    Ok(record)
}
fn decode_project(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut record = json!({"id":null,"body":null,"revision":row.get::<_,i64>(2)?});
    record["id"] = json_column(row, 0)?;
    record["body"] = json_column(row, 1)?;
    Ok(record)
}
pub(super) fn artwork(c: &Context, key: &str) -> Result<Option<Value>> {
    Ok(c.db
        .prepare_cached("SELECT id_json,body,revision,deleted_at FROM artworks WHERE id_key=?")?
        .query_row([key], decode_artwork)
        .optional()?)
}
pub(super) fn project(c: &Context, key: &str) -> Result<Option<Value>> {
    Ok(c.db
        .prepare_cached("SELECT id_json,body,revision FROM projects WHERE id_key=?")?
        .query_row([key], decode_project)
        .optional()?)
}
pub(super) fn read(c: &Context, command: &Value) -> Result<Value> {
    match string(command, "kind")? {
        "readArtworkRecentIndex" => super::recent::read(c, command),
        "searchArtworks" => super::artwork_search::read(c, command),
        "getArtwork" => Ok(artwork(c, &entity_key(&command["id"])?)?.unwrap_or(Value::Null)),
        "getArtworks" => {
            let ids = command["ids"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 200)
                .ok_or_else(|| invalid("Artwork lookup must contain 1–200 IDs"))?;
            let keys = ids.iter().map(entity_key).collect::<Result<Vec<_>>>()?;
            let sql = format!(
                "SELECT id_json,body,revision,deleted_at,id_key FROM artworks WHERE id_key IN ({})",
                vec!["?"; keys.len()].join(",")
            );
            let mut statement = c.db.prepare(&sql)?;
            let mut selected = statement.query(rusqlite::params_from_iter(&keys))?;
            let mut rows = HashMap::new();
            while let Some(row) = selected.next()? {
                c.check_cancel()?;
                rows.insert(row.get::<_, String>(4)?, decode_artwork(row)?);
            }
            // Move each decoded body into its last requested position; only
            // duplicate IDs need a copy, preserving order and missing rows.
            let last: HashMap<_, _> = keys.iter().enumerate().map(|(i, key)| (key, i)).collect();
            Ok(Value::Array(
                keys.iter()
                    .enumerate()
                    .map(|(i, key)| {
                        if last.get(key) == Some(&i) {
                            rows.remove(key).unwrap_or(Value::Null)
                        } else {
                            rows.get(key).cloned().unwrap_or(Value::Null)
                        }
                    })
                    .collect(),
            ))
        }
        "listArtworks" => {
            // Project in SQLite before deserializing large prompt/legacy image
            // bodies. Pagination, revisions and deletion policy stay identical.
            let body = match command.get("projection") {
                None | Some(Value::Null) => "body",
                Some(Value::String(value)) if value == "preference" => {
                    "json_object('id',json_extract(body,'$.id'),'scene',json_extract(body,'$.scene'),'character',json_extract(body,'$.character'),'favorite',body -> '$.favorite','timestamp',json_extract(body,'$.timestamp'))"
                }
                _ => return Err(invalid("Unknown artwork projection")),
            };
            let limit = command
                .get("limit")
                .map(Value::as_i64)
                .unwrap_or(Some(100))
                .filter(|v| (1..=200).contains(v))
                .ok_or_else(|| invalid("List limit must be 1–200"))?;
            let sql = format!(
                "SELECT id_json,{body},revision,deleted_at,id_key FROM artworks WHERE id_key>? {} ORDER BY id_key LIMIT ?",
                if command["includeDeleted"] == true {
                    ""
                } else {
                    "AND deleted_at IS NULL"
                }
            );
            let mut stmt = c.db.prepare(&sql)?;
            let mut rows =
                stmt.query(params![command["cursor"].as_str().unwrap_or(""), limit + 1])?;
            let mut items = Vec::new();
            let mut last = String::new();
            let mut cursor = Value::Null;
            while let Some(row) = rows.next()? {
                c.check_cancel()?;
                if items.len() == limit as usize {
                    cursor = json!(last);
                    break;
                }
                items.push(decode_artwork(row)?);
                last = row.get(4)?;
            }
            let mut result = json!({"items":null,"nextCursor":cursor,"revision":c.revision()?});
            result["items"] = Value::Array(items);
            Ok(result)
        }
        "listProjects" => {
            let mut statement =
                c.db.prepare_cached("SELECT id_json,body,revision FROM projects ORDER BY id_key")?;
            let mut rows = statement.query([])?;
            let mut items = Vec::new();
            while let Some(row) = rows.next()? {
                c.check_cancel()?;
                items.push(decode_project(row)?);
            }
            let mut result = json!({"items":null,"revision":c.revision()?});
            result["items"] = Value::Array(items);
            Ok(result)
        }
        _ => Err(invalid("Unknown record query")),
    }
}
pub(super) fn membership(c: &Context, key: &str) -> Result<Vec<String>> {
    Ok(c.db
        .prepare_cached(
            "SELECT artwork_key FROM project_artworks WHERE project_key=? ORDER BY position",
        )?
        .query_map([key], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}
pub(super) fn update_membership(
    c: &Context,
    key: &str,
    keys: &[String],
    revision: i64,
) -> Result<()> {
    set_membership(c, key, keys)?;
    refresh_membership(c, key, revision)
}
// Membership rows are authoritative inside the transaction. Bulk organization
// updates them in order, then rebuilds each affected album body once.
pub(super) fn set_membership(c: &Context, key: &str, keys: &[String]) -> Result<()> {
    if !c.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id_key=?)",
        [key],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(());
    }
    // Keep the unchanged prefix in place. Append and reverse-order undo need
    // only a tail insert/delete; other edits rebuild the changed suffix.
    let prefix = {
        let mut statement = c.db.prepare_cached(
            "SELECT artwork_key,position FROM project_artworks WHERE project_key=? ORDER BY position",
        )?;
        let mut rows = statement.query([key])?;
        let mut prefix = 0;
        while let Some(row) = rows.next()? {
            if row.get::<_, i64>(1).ok() != Some(prefix as i64) {
                prefix = 0; // Preserve the old normalization of irregular positions.
                break;
            }
            if keys.get(prefix) != Some(&row.get::<_, String>(0)?) {
                break;
            }
            prefix += 1;
        }
        prefix
    };
    if prefix == 0 {
        c.db.execute("DELETE FROM project_artworks WHERE project_key=?", [key])?;
    } else {
        c.db.execute(
            "DELETE FROM project_artworks WHERE project_key=? AND position>=?",
            params![key, prefix as i64],
        )?;
    }
    let mut insert = c.db.prepare_cached(
        "INSERT INTO project_artworks SELECT ?,id_key,? FROM artworks WHERE id_key=? AND deleted_at IS NULL",
    )?;
    for (position, artwork_key) in keys.iter().enumerate().skip(prefix) {
        if insert.execute(params![key, position as i64, artwork_key])? != 1 {
            return Err(ApiError::new(
                404,
                "NOT_FOUND",
                "Project artwork does not exist",
            ));
        }
    }
    Ok(())
}
pub(super) fn refresh_membership(c: &Context, key: &str, revision: i64) -> Result<()> {
    let Some(mut record) = project(c, key)? else {
        return Ok(());
    };
    // Read ordered IDs in one query, retaining rejection of broken/deleted
    // memberships instead of silently omitting them through an inner join.
    let mut statement = c.db.prepare_cached(
        "SELECT a.id_json,a.deleted_at FROM project_artworks p
         LEFT JOIN artworks a ON a.id_key=p.artwork_key
         WHERE p.project_key=? ORDER BY p.position",
    )?;
    let mut rows = statement.query([key])?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        if matches!(row.get_ref(0)?, rusqlite::types::ValueRef::Null)
            || row.get::<_, Option<i64>>(1)?.is_some()
        {
            return Err(ApiError::new(
                404,
                "NOT_FOUND",
                "Project artwork does not exist",
            ));
        }
        ids.push(json_column(row, 0)?);
    }
    record["body"]["history_ids"] = Value::Array(ids);
    c.db.execute(
        "UPDATE projects SET body=?,revision=? WHERE id_key=?",
        params![stringify(&record["body"]), revision, key],
    )?;
    Ok(())
}
pub(super) fn project_refs(c: &Context, key: &str) -> Result<Vec<Value>> {
    Ok(c.db
        .prepare_cached("SELECT project_key,position FROM project_artworks WHERE artwork_key=?")?
        .query_map([key], |r| {
            Ok(json!({"project_key":r.get::<_,String>(0)?,"position":r.get::<_,i64>(1)?}))
        })?
        .collect::<rusqlite::Result<_>>()?)
}
fn soft_delete(
    c: &Context,
    key: &str,
    art: &Value,
    revision: i64,
    deleted: i64,
    refs: &[Value],
) -> Result<()> {
    c.db.execute(
        "INSERT INTO trash VALUES(?,?,?,?)",
        params![
            key,
            deleted,
            stringify(&art["body"]),
            stringify(&json!(refs))
        ],
    )?;
    c.db.execute(
        "UPDATE artworks SET deleted_at=?,revision=? WHERE id_key=?",
        params![deleted, revision, key],
    )?;
    c.db.execute(
        "UPDATE media_refs SET owner_kind='trash' WHERE owner_kind='artwork' AND owner_id=?",
        [key],
    )?;
    Ok(())
}
pub(super) fn mutate(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    if kind == "restoreArtwork"
        && c.operation(principal, string(command, "operationId")?)?
            .is_none_or(|r| r.receipt.is_none())
    {
        let key = entity_key(&command["id"])?;
        // Owner IDs are shared across namespaces; unrelated task/temporary media
        // must not block artwork restoration or add work to its integrity check.
        let refs=c.db.prepare("SELECT m.hash,m.bytes,m.mime FROM media_refs r JOIN media_objects m ON m.hash=r.hash WHERE r.owner_kind IN ('artwork','trash') AND r.owner_id=?")?.query_map([key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for (hash, bytes, mime) in refs {
            media::verify(
                c,
                &media::object_path(&c.root, &hash)?,
                &hash,
                u64::try_from(bytes)
                    .map_err(|_| conflict("MEDIA_INVALID", "Invalid media byte count"))?,
                &mime,
            )?;
        }
    }
    c.transaction(|c| {
        let (op,previous)=c.start_operation(principal,command)?; if let Some(receipt)=previous {return Ok(receipt)}
        let revision=c.next_revision()?;
        let mut receipt=json!({"operationId":command["operationId"],"kind":kind,"revision":revision});
        match kind {
            "saveProject" => project_commands::save(c,command,revision,&mut receipt)?,
            "deleteSmartAlbum" => project_commands::delete_smart(c,command,&mut receipt)?,
            "purgeExpiredTrash" => {
                let keys=c.db.prepare("SELECT artwork_key FROM trash WHERE deleted_at<=?")?.query_map([now()-RETENTION],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                for key in &keys { c.check_cancel()?; c.db.execute("DELETE FROM media_refs WHERE owner_kind='trash' AND owner_id=?",[key])?; c.db.execute("DELETE FROM artworks WHERE id_key=?",[key])?; }
                receipt["purged"]=json!(keys.len());
            }
            "purgeTrash" => purge_selected(c,command,&mut receipt)?,
            "softDeleteArtworks" => batch_delete(c,command,revision,&mut receipt)?,
            _ => {
                let key=entity_key(&command["id"])?;
                let art=artwork(c,&key)?.ok_or_else(||ApiError::new(404,"NOT_FOUND","Artwork does not exist"))?;
                if art["revision"]!=command["expectedRevision"] {return Err(conflict("REVISION_CONFLICT","Artwork has a newer revision"))}
                match kind {
                    "hardDeleteArtwork" => {
                        let refs=project_refs(c,&key)?;
                        for r in &refs { let p=string(r,"project_key")?; update_membership(c,p,&membership(c,p)?.into_iter().filter(|k|k!=&key).collect::<Vec<_>>(),revision)?; }
                        c.db.execute("DELETE FROM media_refs WHERE owner_kind IN ('artwork','trash') AND owner_id=?",[&key])?;
                        c.db.execute("DELETE FROM artworks WHERE id_key=?",[&key])?;
                        receipt["changed"]=json!(true); receipt["removed"]=json!(refs.len());
                    }
                    "patchArtwork" => {
                        let patch=command["patch"].as_object().ok_or_else(||invalid("Artwork patch must be an object"))?;
                        if patch.contains_key("id") || patch.contains_key("image_id") {return Err(invalid("Artwork identity and media cannot be patched"))}
                        if !art["deletedAt"].is_null() {return Err(conflict("OPERATION_CONFLICT","Restore the artwork before editing"))}
                        let mut body=art["body"].clone(); body.as_object_mut().ok_or_else(||invalid("Invalid artwork body"))?.extend(patch.clone());
                        c.db.execute("UPDATE artworks SET body=?,revision=? WHERE id_key=?",params![stringify(&body),revision,key])?;
                    }
                    "softDeleteArtwork" if art["deletedAt"].is_null() => {
                        let refs=project_refs(c,&key)?; soft_delete(c,&key,&art,revision,now(),&refs)?;
                        for r in &refs {let p=string(r,"project_key")?; update_membership(c,p,&membership(c,p)?.into_iter().filter(|k|k!=&key).collect::<Vec<_>>(),revision)?;}
                    }
                    "restoreArtwork" if !art["deletedAt"].is_null() => restore(c,&key,revision)?,
                    _=>{},
                }
                if let Some(updated)=artwork(c,&key)? {receipt["changed"]=json!(updated["revision"]==revision); receipt["artwork"]=updated;}
            }
        }
        c.commit_operation(&op,&receipt)?; Ok(receipt)
    })
}
fn purge_selected(c: &Context, command: &Value, receipt: &mut Value) -> Result<()> {
    let entries = command["entries"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 200)
        .ok_or_else(|| invalid("Trash purge requires 1 to 200 entries"))?;
    let mut seen = HashSet::new();
    let mut purged = 0;
    for entry in entries {
        c.check_cancel()?;
        let key = entity_key(&entry["id"])?;
        let deleted_at = entry["deletedAt"]
            .as_i64()
            .filter(|time| *time >= 0)
            .ok_or_else(|| invalid("Invalid trash deletion timestamp"))?;
        if !seen.insert(key.clone()) {
            return Err(invalid("Duplicate trash purge entry"));
        }
        // The confirmation owns this tombstone, never a restored or newly deleted artwork.
        let exists = c.db.prepare_cached("SELECT EXISTS(SELECT 1 FROM trash t JOIN artworks a ON a.id_key=t.artwork_key WHERE t.artwork_key=? AND t.deleted_at=? AND a.deleted_at=t.deleted_at)")?
            .query_row(params![key,deleted_at], |row| row.get::<_,bool>(0))?;
        if !exists {
            continue;
        }
        c.db.execute(
            "DELETE FROM media_refs WHERE owner_kind='trash' AND owner_id=?",
            [&key],
        )?;
        c.db.execute("DELETE FROM artworks WHERE id_key=?", [&key])?;
        purged += 1;
    }
    receipt["purged"] = json!(purged);
    Ok(())
}
fn restore(c: &Context, key: &str, revision: i64) -> Result<()> {
    let (snapshot, refs) =
        c.db.query_row(
            "SELECT snapshot,project_refs FROM trash WHERE artwork_key=?",
            [key],
            |r| Ok((r.get::<_, String>(0)?, json_column(r, 1)?)),
        )
        .optional()?
        .ok_or_else(|| conflict("WORKSPACE_IDENTITY", "Artwork trash snapshot is missing"))?;
    c.db.execute(
        "UPDATE artworks SET body=?,deleted_at=NULL,revision=? WHERE id_key=?",
        params![snapshot, revision, key],
    )?;
    c.db.execute(
        "UPDATE media_refs SET owner_kind='artwork' WHERE owner_kind='trash' AND owner_id=?",
        [key],
    )?;
    for r in refs
        .as_array()
        .ok_or_else(|| invalid("Invalid trash project references"))?
    {
        let p = string(r, "project_key")?;
        if project(c, p)?.is_none_or(|row| row["body"].get("smartRule").is_some()) {
            continue;
        }
        let mut keys = membership(c, p)?;
        if !keys.iter().any(|k| k == key) {
            keys.insert(
                (r["position"].as_u64().unwrap_or(0) as usize).min(keys.len()),
                key.into(),
            );
        }
        update_membership(c, p, &keys, revision)?;
    }
    c.db.execute("DELETE FROM trash WHERE artwork_key=?", [key])?;
    Ok(())
}
fn batch_delete(c: &Context, command: &Value, revision: i64, receipt: &mut Value) -> Result<()> {
    let items = command["items"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 200)
        .ok_or_else(|| invalid("Delete batch must contain 1–200 artworks"))?;
    let mut selected = HashSet::new();
    let mut seen = HashSet::new();
    let mut affected = BTreeSet::new();
    let mut results = Vec::new();
    let deleted = now();
    for item in items {
        c.check_cancel()?;
        let key = entity_key(&item["id"])?;
        if item["expectedRevision"].as_i64().is_none_or(|v| v < 0) {
            return Err(invalid("Expected artwork revision is required"));
        }
        if !seen.insert(key.clone()) {
            return Err(invalid("Delete batch contains duplicate artworks"));
        }
        let art = artwork(c, &key)?;
        let code = match &art {
            None => Some("NOT_FOUND"),
            Some(a) if !a["deletedAt"].is_null() => Some("NOT_FOUND"),
            Some(a) if a["revision"] != item["expectedRevision"] => Some("REVISION_CONFLICT"),
            _ => None,
        };
        if let Some(code) = code {
            results.push(json!({"id":item["id"],"deleted":false,"code":code}));
            continue;
        }
        let refs = project_refs(c, &key)?;
        for r in &refs {
            affected.insert(string(r, "project_key")?.to_string());
        }
        soft_delete(c, &key, &art.unwrap(), revision, deleted, &refs)?;
        selected.insert(key);
        results.push(json!({"id":item["id"],"deleted":true}));
    }
    for p in affected {
        update_membership(
            c,
            &p,
            &membership(c, &p)?
                .into_iter()
                .filter(|k| !selected.contains(k))
                .collect::<Vec<_>>(),
            revision,
        )?;
    }
    receipt["softDeleteResults"] = json!(results);
    Ok(())
}
