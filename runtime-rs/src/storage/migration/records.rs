use super::*;
use canonical::entity_key;

fn read(c: &Context, id: &str) -> Result<Vec<Value>> {
    c.db.prepare("SELECT body FROM migration_items WHERE migration_id=? ORDER BY item_id")?
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|body| serde_json::from_str(&body).map_err(Into::into))
        .collect()
}
fn collection(records: &[Value], key: &str) -> Result<Vec<Value>> {
    let mut entries = records
        .iter()
        .filter(|r| r["source"] == "kv" && r["key"] == key)
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        a["index"]
            .as_f64()
            .unwrap_or(-1.)
            .total_cmp(&b["index"].as_f64().unwrap_or(-1.))
    });
    if !entries.is_empty() {
        return Ok(entries
            .into_iter()
            .flat_map(|r| {
                if r.get("index").is_none() && r["value"].is_array() {
                    r["value"].as_array().unwrap().clone()
                } else {
                    vec![r["value"].clone()]
                }
            })
            .collect());
    }
    let Some(legacy) = records
        .iter()
        .find(|r| r["source"] == "local" && r["key"] == key)
    else {
        return Ok(Vec::new());
    };
    let value = if let Some(s) = legacy["value"].as_str() {
        serde_json::from_str::<Value>(s)?
    } else {
        legacy["value"].clone()
    };
    value
        .as_array()
        .cloned()
        .ok_or_else(|| format_error("Legacy artwork collection is not an array"))
}
fn body(value: &Value) -> Result<()> {
    if !value.is_object() {
        return Err(format_error("Artwork/project record is invalid"));
    }
    entity_key(&value["id"])?;
    Ok(())
}
pub(super) fn validate(c: &Context, envelope: &Value) -> Result<Vec<String>> {
    let records = read(c, string(envelope, "migrationId")?)?;
    let mut blockers = Vec::new();
    if validate_records(&records, envelope, &mut blockers).is_err() {
        blockers.push("unreadable-domain-record".into());
    }
    let mut seen = HashSet::new();
    blockers.retain(|v| seen.insert(v.clone()));
    Ok(blockers)
}
fn validate_records(records: &[Value], envelope: &Value, blockers: &mut Vec<String>) -> Result<()> {
    let media = envelope["media"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["alias"].as_str().unwrap())
        .collect::<HashSet<_>>();
    let history = collection(records, "aics_pb_history")?;
    let projects = collection(records, "aics_pb_projects")?;
    let trash = collection(records, "aics_pb_trash")?;
    let mut all = history.clone();
    for entry in trash {
        if entry["deletedAt"].as_f64().is_none()
            || !entry["historyEntries"].is_array()
            || !entry["projectRefs"].is_array()
        {
            return Err(format_error("Invalid trash entry"));
        }
        all.extend(entry["historyEntries"].as_array().unwrap().clone());
    }
    let mut artwork_ids = HashSet::new();
    let mut project_ids = HashSet::new();
    for item in &all {
        body(item)?;
        let id = entity_key(&item["id"])?;
        if !artwork_ids.insert(id.clone()) {
            blockers.push("artwork-id-collision".into());
        }
        if item["image_id"]
            .as_str()
            .is_none_or(|id| !media.contains(id))
        {
            blockers.push(format!("missing-original:{id}"));
        }
    }
    let visible = history
        .iter()
        .map(|r| entity_key(&r["id"]))
        .collect::<Result<HashSet<_>>>()?;
    for project in &projects {
        body(project)?;
        let id = entity_key(&project["id"])?;
        if !project_ids.insert(id.clone()) {
            blockers.push("project-id-collision".into());
        }
        let refs = project["history_ids"]
            .as_array()
            .ok_or_else(|| format_error("Invalid project membership"))?
            .iter()
            .map(entity_key)
            .collect::<Result<Vec<_>>>()?;
        if refs.iter().collect::<HashSet<_>>().len() != refs.len()
            || refs.iter().any(|r| !visible.contains(r))
        {
            blockers.push(format!("project-reference:{id}"));
        }
    }
    for record in records {
        let value = record["value"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or_else(|| record["value"].clone());
        check_refs(&value, &media, blockers);
    }
    Ok(())
}
fn check_refs(value: &Value, media: &HashSet<&str>, blockers: &mut Vec<String>) {
    match value {
        Value::Array(array) => {
            for value in array {
                check_refs(value, media, blockers)
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "image_id"
                        | "imageId"
                        | "firstFrameImageId"
                        | "lastFrameImageId"
                        | "sourceImageId"
                ) && value
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && !media.contains(s))
                {
                    blockers.push(format!("missing-reference:{}", value.as_str().unwrap()));
                } else {
                    check_refs(value, media, blockers)
                }
            }
        }
        _ => {}
    }
}
fn insert_artwork(c: &Context, item: &Value, deleted: Option<i64>, revision: i64) -> Result<()> {
    body(item)?;
    let key = entity_key(&item["id"])?;
    c.db.execute(
        "INSERT INTO artworks VALUES(?,?,?,?,?)",
        params![
            key,
            stringify(&item["id"]),
            stringify(item),
            revision,
            deleted
        ],
    )?;
    let hash: String = c.db.query_row(
        "SELECT hash FROM media_aliases WHERE alias=?",
        [string(item, "image_id")?],
        |r| r.get(0),
    )?;
    c.db.execute(
        "INSERT OR IGNORE INTO media_refs VALUES(?,?,?)",
        params![
            if deleted.is_some() {
                "trash"
            } else {
                "artwork"
            },
            key,
            hash
        ],
    )?;
    Ok(())
}
pub(super) fn publish(c: &Context, envelope: &Value, revision: i64) -> Result<()> {
    let records = read(c, string(envelope, "migrationId")?)?;
    let history = collection(&records, "aics_pb_history")?;
    let projects = collection(&records, "aics_pb_projects")?;
    let trash = collection(&records, "aics_pb_trash")?;
    for artwork in &history {
        c.check_cancel()?;
        insert_artwork(c, artwork, None, revision)?;
    }
    for project in &projects {
        body(project)?;
        let key = entity_key(&project["id"])?;
        c.db.execute(
            "INSERT INTO projects VALUES(?,?,?,?)",
            params![key, stringify(&project["id"]), stringify(project), revision],
        )?;
        for (position, id) in project["history_ids"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            c.db.execute(
                "INSERT INTO project_artworks VALUES(?,?,?)",
                params![key, entity_key(id)?, position as i64],
            )?;
        }
    }
    for entry in trash {
        for item in entry["historyEntries"]
            .as_array()
            .ok_or_else(|| format_error("Invalid trash entry"))?
        {
            c.check_cancel()?;
            let deleted = entry["deletedAt"]
                .as_f64()
                .ok_or_else(|| format_error("Invalid deletion timestamp"))?
                as i64;
            insert_artwork(c, item, Some(deleted), revision)?;
            let mut refs = Vec::new();
            for reference in entry["projectRefs"]
                .as_array()
                .ok_or_else(|| format_error("Invalid trash references"))?
            {
                if reference["hadReference"] != true {
                    continue;
                }
                let project_key = entity_key(&reference["projectId"])?;
                if let Some(project) = projects
                    .iter()
                    .find(|p| entity_key(&p["id"]).is_ok_and(|key| key == project_key))
                {
                    refs.push(json!({"project_key":project_key,"position":project["history_ids"].as_array().unwrap().len()}));
                }
            }
            c.db.execute(
                "INSERT INTO trash VALUES(?,?,?,?)",
                params![
                    entity_key(&item["id"])?,
                    deleted,
                    stringify(item),
                    stringify(&json!(refs))
                ],
            )?;
        }
    }
    for record in &records {
        let domain = record["domain"].as_str().unwrap_or("");
        if !matches!(domain, "settings" | "chat" | "draft") {
            continue;
        }
        let key = string(record, "key")?;
        if record["source"] == "local"
            && key == "aics_chat_archive_v1"
            && records
                .iter()
                .any(|r| r["key"] == "chat_archive_v1" && r["source"] == "kv")
        {
            continue;
        }
        let key = if record["source"] == "session" {
            format!("{}:{key}", string(record, "windowId")?)
        } else if key == "chat_archive_v1" {
            "aics_chat_archive_v1".into()
        } else {
            key.into()
        };
        c.db.execute(
            "INSERT INTO profile_records VALUES(?,?,?,?)",
            params![domain, key, stringify(&record["value"]), revision],
        )?;
    }
    Ok(())
}
