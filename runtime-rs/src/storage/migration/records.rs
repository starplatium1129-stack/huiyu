use super::*;
use canonical::entity_key;
use std::{borrow::Cow, collections::HashMap};

pub(super) fn read(c: &Context, id: &str) -> Result<Vec<Value>> {
    // Decode borrowed row text, but retain JSON errors until SQLite reading succeeds.
    c.db.prepare("SELECT body FROM migration_items WHERE migration_id=? ORDER BY item_id")?
        .query_map([id], |row| Ok(serde_json::from_str::<Value>(text_column(row, 0)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .collect::<serde_json::Result<Vec<_>>>()
        .map_err(Into::into)
}
fn collection<'a>(records: &'a [Value], key: &str) -> Result<Vec<Cow<'a, Value>>> {
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
        let mut values = Vec::new();
        for record in entries {
            let value = &record["value"];
            if record.get("index").is_none() && value.is_array() {
                values.extend(value.as_array().unwrap().iter().map(Cow::Borrowed));
            } else {
                values.push(Cow::Borrowed(value));
            }
        }
        return Ok(values);
    }
    let Some(legacy) = records
        .iter()
        .find(|r| r["source"] == "local" && r["key"] == key)
    else {
        return Ok(Vec::new());
    };
    if let Some(text) = legacy["value"].as_str() {
        return match serde_json::from_str::<Value>(text)? {
            Value::Array(values) => Ok(values.into_iter().map(Cow::Owned).collect()),
            _ => Err(format_error("Legacy artwork collection is not an array")),
        };
    }
    legacy["value"]
        .as_array()
        .map(|values| values.iter().map(Cow::Borrowed).collect())
        .ok_or_else(|| format_error("Legacy artwork collection is not an array"))
}
fn body(value: &Value) -> Result<()> {
    if !value.is_object() {
        return Err(format_error("Artwork/project record is invalid"));
    }
    entity_key(&value["id"])?;
    Ok(())
}
pub(super) fn validate(records: &[Value], envelope: &Value) -> Result<Vec<String>> {
    string(envelope, "migrationId")?;
    let mut blockers = Vec::new();
    if validate_records(records, envelope, &mut blockers).is_err() {
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
    let mut all = history
        .iter()
        .map(|value| value.as_ref())
        .collect::<Vec<&Value>>();
    for entry in &trash {
        if entry["deletedAt"].as_f64().is_none()
            || !entry["historyEntries"].is_array()
            || !entry["projectRefs"].is_array()
        {
            return Err(format_error("Invalid trash entry"));
        }
        all.extend(entry["historyEntries"].as_array().unwrap().iter());
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
        if let Some(value) = record["value"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
        {
            check_refs(&value, &media, blockers);
        } else {
            check_refs(&record["value"], &media, blockers);
        }
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
                if profile::media_refs::ALIAS_FIELDS.contains(&key.as_str())
                    && value
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
fn insert_artwork(c: &Context, item: &Value, deleted: Option<i64>, revision: i64) -> Result<String> {
    body(item)?;
    let key = entity_key(&item["id"])?;
    let snapshot = stringify(item);
    c.db.prepare_cached("INSERT INTO artworks VALUES(?,?,?,?,?)")?
        .execute(params![
            key,
            stringify(&item["id"]),
            snapshot,
            revision,
            deleted
        ])?;
    let hash: String = c.db
        .prepare_cached("SELECT hash FROM media_aliases WHERE alias=?")?
        .query_row([string(item, "image_id")?], |r| r.get(0))?;
    c.db.prepare_cached("INSERT OR IGNORE INTO media_refs VALUES(?,?,?)")?
        .execute(params![
            if deleted.is_some() {
                "trash"
            } else {
                "artwork"
            },
            key,
            hash
        ])?;
    Ok(snapshot)
}
pub(super) fn publish(
    c: &Context,
    records: &[Value],
    envelope: &Value,
    revision: i64,
) -> Result<()> {
    string(envelope, "migrationId")?;
    let history = collection(records, "aics_pb_history")?;
    let projects = collection(records, "aics_pb_projects")?;
    let trash = collection(records, "aics_pb_trash")?;
    for artwork in &history {
        c.check_cancel()?;
        insert_artwork(c, artwork, None, revision)?;
    }
    let mut project_positions = HashMap::new();
    for project in &projects {
        body(project)?;
        let key = entity_key(&project["id"])?;
        c.db.prepare_cached("INSERT INTO projects VALUES(?,?,?,?)")?
            .execute(params![
                key,
                stringify(&project["id"]),
                stringify(project),
                revision
            ])?;
        for (position, id) in project["history_ids"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            c.db.prepare_cached("INSERT INTO project_artworks VALUES(?,?,?)")?
                .execute(params![key, entity_key(id)?, position as i64])?;
        }
        if !trash.is_empty() {
            project_positions
                .entry(key)
                .or_insert(project["history_ids"].as_array().unwrap().len());
        }
    }
    for entry in trash {
        let mut refs_json = None;
        for item in entry["historyEntries"]
            .as_array()
            .ok_or_else(|| format_error("Invalid trash entry"))?
        {
            c.check_cancel()?;
            let deleted = entry["deletedAt"]
                .as_f64()
                .ok_or_else(|| format_error("Invalid deletion timestamp"))?
                as i64;
            let snapshot = insert_artwork(c, item, Some(deleted), revision)?;
            if refs_json.is_none() {
                let mut refs = Vec::new();
                for reference in entry["projectRefs"]
                    .as_array()
                    .ok_or_else(|| format_error("Invalid trash references"))?
                {
                    if reference["hadReference"] != true {
                        continue;
                    }
                    let project_key = entity_key(&reference["projectId"])?;
                    if let Some(position) = project_positions.get(&project_key) {
                        refs.push(json!({"project_key":project_key,"position":position}));
                    }
                }
                refs_json = Some(stringify(&Value::Array(refs)));
            }
            c.db.prepare_cached("INSERT INTO trash VALUES(?,?,?,?)")?
                .execute(params![
                    entity_key(&item["id"])?,
                    deleted,
                    snapshot,
                    refs_json.as_deref().unwrap()
                ])?;
        }
    }
    for record in records {
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
        c.db.prepare_cached("INSERT INTO profile_records VALUES(?,?,?,?)")?
            .execute(params![domain, key, stringify(&record["value"]), revision])?;
        profile::media_refs::replace(c, domain, &key, &record["value"])?;
    }
    Ok(())
}
