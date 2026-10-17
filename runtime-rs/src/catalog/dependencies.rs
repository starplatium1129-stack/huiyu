use super::*;
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
};
type ChangeIndex = HashMap<String, HashMap<String, usize>>;
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
    index: &mut ChangeIndex,
    record: Record,
    modify: impl FnOnce(&mut Value) -> bool,
) -> Result<()> {
    let existing = index
        .get(&record.kind)
        .and_then(|ids| ids.get(&record.id))
        .copied();
    if existing.is_some_and(|at| changes[at].remove) {
        return Ok(());
    }
    let mut data = existing
        .and_then(|at| changes[at].data.clone())
        .unwrap_or(record.data);
    if let Some(patch) = existing.and_then(|at| changes[at].patch.as_ref()) {
        write::merge(&mut data, patch)?;
    }
    if !modify(&mut data) {
        return Ok(());
    }
    if let Some(at) = existing {
        changes[at].data = Some(data);
        changes[at].patch = None;
    } else {
        index
            .entry(record.kind.clone())
            .or_default()
            .insert(record.id.clone(), changes.len());
        changes.push(Change {
            kind: record.kind,
            id: record.id,
            expected_revision: record.revision,
            data: Some(data),
            patch: None,
            sort_order: None,
            created_at: None,
            remove: false,
        });
    }
    Ok(())
}
fn retain_ids(ids: &mut Vec<Value>, retired: &HashSet<&str>) -> bool {
    let count = ids.len();
    ids.retain(|id| !id.as_str().is_some_and(|id| retired.contains(id)));
    count != ids.len()
}
pub(super) fn expand<'a>(
    connection: &Connection,
    input: &'a [Change],
) -> Result<Cow<'a, [Change]>> {
    // Ordinary edits cannot expand dependencies. Borrow their payloads instead
    // of cloning the entire change set before the normal write validation.
    if !input.iter().any(|change| {
        (change.kind == "document" && change.id == "tags")
            || (change.kind == "scene" && change.remove)
    }) {
        return Ok(Cow::Borrowed(input));
    }
    let mut changes = input.to_vec();
    let mut index = ChangeIndex::new();
    for (at, change) in changes.iter().enumerate() {
        // The original linear lookup selected the first input occurrence;
        // duplicate records are still rejected later by apply_with_seeds.
        index
            .entry(change.kind.clone())
            .or_default()
            .entry(change.id.clone())
            .or_insert(at);
    }
    if let Some(change) = input
        .iter()
        .find(|c| c.kind == "document" && c.id == "tags")
    {
        let before = document(connection, "tags")?;
        let after = change.data.as_ref().unwrap_or(&before);
        let next = after
            .as_array()
            .ok_or_else(|| ApiError::invalid("标签库需要完整数组"))?;
        let before = before
            .as_array()
            .ok_or_else(|| ApiError::invalid("现有标签库无效"))?;
        let mut next_by_id = HashMap::new();
        let mut next_names = HashSet::new();
        for tag in next {
            // Keep raw JSON equality and the first duplicate ID, just like
            // the original lookup before normal tag validation runs.
            next_by_id.entry(&tag["id"]).or_insert(tag);
            next_names.insert(&tag["en"]);
        }
        let mut renamed = HashMap::new();
        let mut removed = HashSet::new();
        for tag in before {
            let name = tag["en"].as_str().unwrap_or("");
            if let Some(replacement) = next_by_id.get(&tag["id"]) {
                if replacement["en"] != tag["en"] && !next_names.contains(&tag["en"]) {
                    renamed.insert(name.to_owned(), replacement["en"].clone());
                }
            } else if !next_names.contains(&tag["en"]) {
                removed.insert(name.to_owned());
            }
        }
        if !renamed.is_empty() || !removed.is_empty() {
            for record in rows(connection, "scene")? {
                update(&mut changes, &mut index, record, |data| {
                    let mut changed = false;
                    if let Some(tags) = data.get_mut("tags").and_then(Value::as_array_mut) {
                        tags.retain_mut(|tag| {
                            if tag.as_str().is_some_and(|name| removed.contains(name)) {
                                changed = true;
                                return false;
                            }
                            if let Some(replacement) =
                                tag.as_str().and_then(|name| renamed.get(name))
                                && tag != replacement
                            {
                                *tag = replacement.clone();
                                changed = true;
                            }
                            true
                        });
                    }
                    changed
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
            update(&mut changes, &mut index, record, |data| {
                data.get_mut("profile")
                    .and_then(|profile| profile.get_mut("lora"))
                    .and_then(|lora| lora.get_mut("recommended_scene"))
                    .and_then(Value::as_array_mut)
                    .is_some_and(|ids| retain_ids(ids, &retired))
            })?;
        }
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM content_records WHERE kind='document' AND deleted=0
             AND id IN ('curation','loras') ORDER BY sort_order,id"
        ))?;
        let documents = statement
            .query_map([], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for record in documents {
            if record.id == "curation" {
                update(&mut changes, &mut index, record, |data| {
                    let mut changed = false;
                    for field in [
                        "personaCoreSceneIds",
                        "signatureSceneIds",
                        "curatedSceneIds",
                        "reviewSceneIds",
                    ] {
                        if let Some(ids) = data.get_mut(field).and_then(Value::as_array_mut) {
                            changed |= retain_ids(ids, &retired);
                        }
                    }
                    for field in ["recommendationReasons", "personaCoreReasons"] {
                        if let Some(map) = data.get_mut(field).and_then(Value::as_object_mut) {
                            let count = map.len();
                            map.retain(|id, _| !retired.contains(id.as_str()));
                            changed |= count != map.len();
                        }
                    }
                    changed
                })?;
            } else if record.id == "loras" {
                update(&mut changes, &mut index, record, |data| {
                    let mut changed = false;
                    if let Some(loras) = data.as_array_mut() {
                        for lora in loras {
                            for field in ["related_scenes", "scenes"] {
                                if let Some(ids) = lora.get_mut(field).and_then(Value::as_array_mut)
                                {
                                    changed |= retain_ids(ids, &retired);
                                }
                            }
                        }
                    }
                    changed
                })?;
            }
        }
    }
    Ok(Cow::Owned(changes))
}
