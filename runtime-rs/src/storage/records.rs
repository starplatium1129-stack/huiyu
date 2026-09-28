use super::*;
use canonical::{entity_key, stringify};
use rusqlite::{OptionalExtension, Row, params};
use std::collections::{BTreeSet, HashSet};
pub(super) const RETENTION: i64 = 30 * 24 * 60 * 60 * 1000;
fn json_column(row: &Row<'_>, column: usize) -> rusqlite::Result<Value> {
    let value: String = row.get(column)?;
    serde_json::from_str(&value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e))
    })
}
pub(super) fn decode_artwork(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":json_column(row,0)?,"body":json_column(row,1)?,"revision":row.get::<_,i64>(2)?,"deletedAt":row.get::<_,Option<i64>>(3)?}),
    )
}
fn decode_project(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({"id":json_column(row,0)?,"body":json_column(row,1)?,"revision":row.get::<_,i64>(2)?}))
}
pub(super) fn artwork(c: &Context, key: &str) -> Result<Option<Value>> {
    Ok(c.db
        .prepare_cached("SELECT id_json,body,revision,deleted_at FROM artworks WHERE id_key=?")?
        .query_row([key], decode_artwork)
        .optional()?)
}
fn project(c: &Context, key: &str) -> Result<Option<Value>> {
    Ok(c.db
        .prepare_cached("SELECT id_json,body,revision FROM projects WHERE id_key=?")?
        .query_row([key], decode_project)
        .optional()?)
}
pub(super) fn read(c: &Context, command: &Value) -> Result<Value> {
    match string(command, "kind")? {
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
            let rows =
                c.db.prepare(&sql)?
                    .query_map(rusqlite::params_from_iter(&keys), |r| {
                        Ok((r.get::<_, String>(4)?, decode_artwork(r)?))
                    })?
                    .collect::<rusqlite::Result<HashMap<_, _>>>()?;
            Ok(Value::Array(
                keys.iter()
                    .map(|key| rows.get(key).cloned().unwrap_or(Value::Null))
                    .collect(),
            ))
        }
        "listArtworks" => {
            let limit = command
                .get("limit")
                .map(Value::as_i64)
                .unwrap_or(Some(100))
                .filter(|v| (1..=200).contains(v))
                .ok_or_else(|| invalid("List limit must be 1–200"))?;
            let sql = format!(
                "SELECT id_json,body,revision,deleted_at,id_key FROM artworks WHERE id_key>? {} ORDER BY id_key LIMIT ?",
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
                if items.len() == limit as usize {
                    cursor = json!(last);
                    break;
                }
                items.push(decode_artwork(row)?);
                last = row.get(4)?;
            }
            Ok(json!({"items":items,"nextCursor":cursor,"revision":c.revision()?}))
        }
        "listProjects" => {
            let items =
                c.db.prepare_cached("SELECT id_json,body,revision FROM projects ORDER BY id_key")?
                    .query_map([], decode_project)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({"items":items,"revision":c.revision()?}))
        }
        _ => Err(invalid("Unknown record query")),
    }
}
fn membership(c: &Context, key: &str) -> Result<Vec<String>> {
    Ok(c.db
        .prepare_cached(
            "SELECT artwork_key FROM project_artworks WHERE project_key=? ORDER BY position",
        )?
        .query_map([key], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}
fn update_membership(c: &Context, key: &str, keys: &[String], revision: i64) -> Result<()> {
    let Some(mut record) = project(c, key)? else {
        return Ok(());
    };
    c.db.execute("DELETE FROM project_artworks WHERE project_key=?", [key])?;
    let mut ids = Vec::with_capacity(keys.len());
    let mut find =
        c.db.prepare_cached("SELECT id_json,deleted_at FROM artworks WHERE id_key=?")?;
    let mut insert =
        c.db.prepare_cached("INSERT INTO project_artworks VALUES(?,?,?)")?;
    for (position, artwork_key) in keys.iter().enumerate() {
        let row = find
            .query_row([artwork_key], |r| {
                Ok((json_column(r, 0)?, r.get::<_, Option<i64>>(1)?))
            })
            .optional()?;
        let Some((id, None)) = row else {
            return Err(ApiError::new(
                404,
                "NOT_FOUND",
                "Project artwork does not exist",
            ));
        };
        insert.execute(params![key, artwork_key, position as i64])?;
        ids.push(id);
    }
    record["body"]["history_ids"] = json!(ids);
    c.db.execute(
        "UPDATE projects SET body=?,revision=? WHERE id_key=?",
        params![stringify(&record["body"]), revision, key],
    )?;
    Ok(())
}
fn project_refs(c: &Context, key: &str) -> Result<Vec<Value>> {
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
        let refs=c.db.prepare("SELECT m.hash,m.bytes,m.mime FROM media_refs r JOIN media_objects m ON m.hash=r.hash WHERE r.owner_id=?")?.query_map([key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
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
            "saveProject" => {
                let mut body=command["project"].clone(); let key=entity_key(&body["id"])?; let current=project(c,&key)?;
                if current.as_ref().map(|p|&p["revision"]).unwrap_or(&Value::Null)!=&command["expectedRevision"] {return Err(conflict("REVISION_CONFLICT","Project has a newer revision"))}
                let keys=command["artworkIds"].as_array().ok_or_else(||invalid("Project artwork IDs must be an array"))?.iter().map(entity_key).collect::<Result<Vec<_>>>()?;
                if keys.iter().collect::<HashSet<_>>().len()!=keys.len() {return Err(invalid("Project contains duplicate artworks"))}
                if let Some(current)=current {body["id"]=current["id"].clone();}
                c.db.execute("INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(id_key) DO UPDATE SET body=excluded.body,revision=excluded.revision",params![key,stringify(&body["id"]),stringify(&body),revision])?;
                update_membership(c,&key,&keys,revision)?; receipt["project"]=project(c,&key)?.unwrap();
            }
            "purgeExpiredTrash" => {
                let keys=c.db.prepare("SELECT artwork_key FROM trash WHERE deleted_at<=?")?.query_map([now()-RETENTION],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                for key in &keys { c.check_cancel()?; c.db.execute("DELETE FROM media_refs WHERE owner_kind='trash' AND owner_id=?",[key])?; c.db.execute("DELETE FROM artworks WHERE id_key=?",[key])?; }
                receipt["purged"]=json!(keys.len());
            }
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
        if project(c, p)?.is_none() {
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
