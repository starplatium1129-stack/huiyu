use super::*;
use std::collections::{HashMap, HashSet};
pub(super) fn rows(connection: &Connection, kind: &str) -> Result<Vec<Record>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM content_records WHERE kind=?1 AND deleted=0 ORDER BY sort_order,id"
    ))?;
    Ok(statement
        .query_map([kind], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
pub(super) fn document(connection: &Connection, id: &str) -> Result<Value> {
    Ok(serde_json::from_str(
        &connection.query_row::<String, _, _>(
            "SELECT payload FROM content_records WHERE kind='document' AND id=?1 AND deleted=0",
            [id],
            |r| r.get(0),
        )?,
    )?)
}
fn update(
    changes: &mut Vec<Change>,
    record: Record,
    modify: impl FnOnce(&mut Value),
) -> Result<()> {
    let existing = changes
        .iter()
        .position(|c| c.kind == record.kind && c.id == record.id);
    if existing.is_some_and(|at| changes[at].remove) {
        return Ok(());
    }
    let mut data = existing
        .and_then(|at| changes[at].data.clone())
        .unwrap_or_else(|| record.data.clone());
    if let Some(patch) = existing.and_then(|at| changes[at].patch.as_ref()) {
        write::merge(&mut data, patch)?;
    }
    let before = data.clone();
    modify(&mut data);
    if data == before {
        return Ok(());
    }
    if let Some(at) = existing {
        changes[at].data = Some(data);
        changes[at].patch = None;
    } else {
        changes.push(Change {
            kind: record.kind,
            id: record.id,
            expected_revision: record.revision,
            data: Some(data),
            patch: None,
            sort_order: None,
            remove: false,
        });
    }
    Ok(())
}
pub(super) fn expand(connection: &Connection, input: &[Change]) -> Result<Vec<Change>> {
    let mut changes = input.to_vec();
    if let Some(change) = input
        .iter()
        .find(|c| c.kind == "document" && c.id == "tags")
    {
        let before = document(connection, "tags")?;
        let after = change.data.as_ref().unwrap_or(&before);
        let next = after
            .as_array()
            .ok_or_else(|| ApiError::invalid("标签库需要完整数组"))?;
        let mut renamed = HashMap::new();
        let mut removed = HashSet::new();
        for tag in before
            .as_array()
            .ok_or_else(|| ApiError::invalid("现有标签库无效"))?
        {
            let name = tag["en"].as_str().unwrap_or("");
            if let Some(replacement) = next.iter().find(|t| t["id"] == tag["id"]) {
                if replacement["en"] != tag["en"] && !next.iter().any(|t| t["en"] == tag["en"]) {
                    renamed.insert(name.to_owned(), replacement["en"].clone());
                }
            } else if !next.iter().any(|t| t["en"] == tag["en"]) {
                removed.insert(name.to_owned());
            }
        }
        if !renamed.is_empty() || !removed.is_empty() {
            for record in rows(connection, "scene")? {
                update(&mut changes, record, |data| {
                    if let Some(tags) = data["tags"].as_array() {
                        data["tags"] = tags
                            .iter()
                            .filter(|v| !v.as_str().is_some_and(|s| removed.contains(s)))
                            .map(|v| v.as_str().and_then(|s| renamed.get(s)).unwrap_or(v).clone())
                            .collect::<Vec<_>>()
                            .into();
                    }
                })?;
            }
        }
    }
    let retired = input
        .iter()
        .filter(|c| c.kind == "scene" && c.remove)
        .map(|c| c.id.as_str())
        .collect::<HashSet<_>>();
    if !retired.is_empty() {
        for record in rows(connection, "character")? {
            update(&mut changes, record, |data| {
                if let Some(ids) = data["profile"]["lora"]["recommended_scene"].as_array_mut() {
                    ids.retain(|id| !id.as_str().is_some_and(|id| retired.contains(id)));
                }
            })?;
        }
        for record in rows(connection, "document")? {
            if record.id == "curation" {
                update(&mut changes, record, |data| {
                    for field in [
                        "personaCoreSceneIds",
                        "signatureSceneIds",
                        "curatedSceneIds",
                        "reviewSceneIds",
                    ] {
                        if let Some(ids) = data[field].as_array_mut() {
                            ids.retain(|id| !id.as_str().is_some_and(|id| retired.contains(id)));
                        }
                    }
                    for field in ["recommendationReasons", "personaCoreReasons"] {
                        if let Some(map) = data[field].as_object_mut() {
                            map.retain(|id, _| !retired.contains(id.as_str()));
                        }
                    }
                })?;
            } else if record.id == "loras" {
                update(&mut changes, record, |data| {
                    if let Some(loras) = data.as_array_mut() {
                        for lora in loras {
                            for field in ["related_scenes", "scenes"] {
                                if let Some(ids) = lora[field].as_array_mut() {
                                    ids.retain(|id| {
                                        !id.as_str().is_some_and(|id| retired.contains(id))
                                    });
                                }
                            }
                        }
                    }
                })?;
            }
        }
    }
    Ok(changes)
}
