use super::*;
use canonical::entity_key;
use rusqlite::params;
use std::collections::{BTreeSet, HashSet};

#[cfg(test)]
mod tests;

fn field(body: &Value, name: &str) -> Value {
    match body.get(name) {
        Some(value) => json!({"present":true,"value":value}),
        None => json!({"present":false}),
    }
}

fn memberships(c: &Context, key: &str) -> Result<Vec<Value>> {
    records::project_refs(c, key)?
        .iter()
        .map(|reference| {
            let project = records::project(c, string(reference, "project_key")?)?
                .ok_or_else(|| conflict("MEMBERSHIP_INVALID", "Album membership is unavailable"))?;
            Ok(json!({"projectId":project["id"],"position":reference["position"]}))
        })
        .collect()
}

fn state(c: &Context, art: &Value, project: bool, tags: bool) -> Result<Value> {
    let mut value = json!({});
    if project {
        value["project"] = field(&art["body"], "project");
        value["memberships"] = json!(memberships(c, &entity_key(&art["id"])?)?);
    }
    if tags {
        value["collectionTags"] = field(&art["body"], "collectionTags");
    }
    Ok(value)
}

fn tag_list(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .filter(|items| items.len() <= 64)
        .ok_or_else(|| invalid("Collection tags must be an array of at most 64 strings"))?;
    let mut tags = Vec::new();
    for value in items {
        let tag = value
            .as_str()
            .map(str::trim)
            .filter(|tag| !tag.is_empty() && tag.chars().count() <= 64)
            .ok_or_else(|| invalid("Collection tags must contain 1–64 characters"))?;
        if !tags.iter().any(|old| old == tag) {
            tags.push(tag.to_owned());
        }
    }
    Ok(tags)
}

fn replace_memberships(c: &Context, key: &str, references: &[Value], revision: i64) -> Result<()> {
    let before = memberships(c, key)?;
    let albums = before
        .iter()
        .chain(references)
        .map(|reference| entity_key(&reference["projectId"]))
        .collect::<Result<BTreeSet<_>>>()?;
    for album in albums {
        let mut keys = records::membership(c, &album)?;
        keys.retain(|value| value != key);
        if let Some(reference) = references
            .iter()
            .find(|reference| entity_key(&reference["projectId"]).is_ok_and(|value| value == album))
        {
            let position = reference["position"]
                .as_u64()
                .ok_or_else(|| invalid("Album position is invalid"))?;
            keys.insert((position as usize).min(keys.len()), key.to_owned());
        }
        records::update_membership(c, &album, &keys, revision)?;
    }
    Ok(())
}

fn organize(c: &Context, command: &Value, revision: i64) -> Result<Vec<Value>> {
    let ids = command["ids"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 200)
        .ok_or_else(|| invalid("Artwork organization must contain 1–200 IDs"))?;
    let keys = ids.iter().map(entity_key).collect::<Result<Vec<_>>>()?;
    if keys.iter().collect::<HashSet<_>>().len() != keys.len() {
        return Err(invalid("Artwork IDs must be unique"));
    }
    let expected = command["expectedRevisions"]
        .as_array()
        .filter(|items| items.len() == ids.len())
        .ok_or_else(|| invalid("Expected artwork revisions are required"))?;
    let project_change = command.get("projectId").is_some();
    let project = match command.get("projectId") {
        None | Some(Value::Null) => None,
        Some(id) => Some(
            records::project(c, &entity_key(id)?)?
                .ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Album no longer exists"))?,
        ),
    };
    if project
        .as_ref()
        .is_some_and(|row| row["body"].get("smartRule").is_some())
    {
        return Err(invalid(
            "Smart albums collect artwork by conditions; edit the album rule",
        ));
    }
    let tags_change = command.get("collectionTags").is_some();
    if tags_change && !command["collectionTags"].is_object() {
        return Err(invalid("Collection tag changes must be an object"));
    }
    let add = tag_list(command["collectionTags"].get("add"))?;
    let remove = tag_list(command["collectionTags"].get("remove"))?;
    if !project_change && add.is_empty() && remove.is_empty() {
        return Err(invalid("No organization changes were requested"));
    }
    let mut changes = Vec::new();
    for key in keys {
        c.check_cancel()?;
        let mut art = records::artwork(c, &key)?
            .filter(|row| row["deletedAt"].is_null())
            .ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Artwork no longer exists"))?;
        let expected = expected
            .iter()
            .find(|row| entity_key(&row["id"]).is_ok_and(|id| id == key))
            .ok_or_else(|| invalid("Artwork expected revision is missing"))?;
        if expected["revision"] != art["revision"] {
            return Err(conflict(
                "REVISION_CONFLICT",
                "Artwork has a newer revision",
            ));
        }
        let before = state(c, &art, project_change, tags_change)?;
        if project_change {
            let refs = if let Some(project) = &project {
                let project_key = entity_key(&project["id"])?;
                let position = records::membership(c, &project_key)?
                    .iter()
                    .position(|id| id == &key)
                    .unwrap_or(records::membership(c, &project_key)?.len());
                // The recipe project field is text; album IDs retain their
                // original JSON type in project rows and membership arrays.
                art["body"]["project"] = json!(project_key);
                vec![json!({"projectId":project["id"],"position":position})]
            } else {
                art["body"]
                    .as_object_mut()
                    .ok_or_else(|| invalid("Artwork body is invalid"))?
                    .remove("project");
                Vec::new()
            };
            replace_memberships(c, &key, &refs, revision)?;
        }
        if tags_change {
            let mut tags: Vec<String> = art["body"]["collectionTags"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|tag| !tag.is_empty() && !remove.iter().any(|old| old == tag))
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            for tag in &add {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            let mut seen = HashSet::new();
            tags.retain(|tag| seen.insert(tag.clone()));
            if tags.len() > 64 {
                return Err(invalid("An artwork can have at most 64 collection tags"));
            }
            art["body"]["collectionTags"] = json!(tags);
        }
        let after = state(c, &art, project_change, tags_change)?;
        if before != after {
            c.db.execute(
                "UPDATE artworks SET body=?,revision=? WHERE id_key=?",
                params![stringify(&art["body"]), revision, key],
            )?;
            changes.push(json!({"id":art["id"],"before":before,"after":after}));
        }
    }
    Ok(changes)
}

fn same_albums(a: &[Value], b: &[Value]) -> Result<bool> {
    let keys = |values: &[Value]| {
        values
            .iter()
            .map(|value| entity_key(&value["projectId"]))
            .collect::<Result<BTreeSet<_>>>()
    };
    Ok(keys(a)? == keys(b)?)
}

fn undo(c: &Context, principal: &str, command: &Value, revision: i64) -> Result<Value> {
    let source = c
        .operation(principal, string(command, "sourceOperationId")?)?
        .filter(|row| row.kind == "organizeArtworks" && row.state == "committed")
        .and_then(|row| row.receipt)
        .ok_or_else(|| conflict("UNDO_UNAVAILABLE", "Organization receipt is unavailable"))?;
    let changes = source["changes"]
        .as_array()
        .ok_or_else(|| conflict("UNDO_UNAVAILABLE", "Organization receipt is invalid"))?;
    let mut restored = 0;
    let mut skipped = 0;
    for change in changes.iter().rev() {
        c.check_cancel()?;
        let key = entity_key(&change["id"])?;
        let Some(mut art) = records::artwork(c, &key)?.filter(|row| row["deletedAt"].is_null())
        else {
            skipped += 1;
            continue;
        };
        let after = &change["after"];
        let before = &change["before"];
        let changed_field = ["project", "collectionTags"].iter().any(|name| {
            after
                .get(name)
                .is_some_and(|value| field(&art["body"], name) != *value)
        });
        let changed_memberships = match after.get("memberships").and_then(Value::as_array) {
            Some(refs) => !same_albums(&memberships(c, &key)?, refs)?,
            None => false,
        };
        let old_refs = before.get("memberships").and_then(Value::as_array);
        let missing_album = old_refs.is_some_and(|refs| {
            refs.iter().any(|reference| {
                entity_key(&reference["projectId"])
                    .and_then(|key| records::project(c, &key))
                    .is_ok_and(|project| project.is_none())
            })
        });
        if changed_field || changed_memberships || missing_album {
            skipped += 1;
            continue;
        }
        for name in ["project", "collectionTags"] {
            if let Some(previous) = before.get(name) {
                if previous["present"] == true {
                    art["body"][name] = previous["value"].clone();
                } else {
                    art["body"]
                        .as_object_mut()
                        .ok_or_else(|| invalid("Artwork body is invalid"))?
                        .remove(name);
                }
            }
        }
        if let Some(refs) = old_refs {
            replace_memberships(c, &key, refs, revision)?;
        }
        c.db.execute(
            "UPDATE artworks SET body=?,revision=? WHERE id_key=?",
            params![stringify(&art["body"]), revision, key],
        )?;
        restored += 1;
    }
    Ok(json!({"restored":restored,"skipped":skipped}))
}

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    c.transaction(|c| {
        let (operation, previous) = c.start_operation(principal, command)?;
        if let Some(receipt) = previous {
            return Ok(receipt);
        }
        let revision = c.next_revision()?;
        let kind = string(command, "kind")?;
        let mut receipt = match kind {
            "organizeArtworks" => json!({"changes":organize(c, command, revision)?}),
            "undoArtworkOrganization" => undo(c, principal, command, revision)?,
            _ => return Err(invalid("Unknown artwork organization command")),
        };
        receipt["operationId"] = command["operationId"].clone();
        receipt["kind"] = json!(kind);
        receipt["revision"] = json!(revision);
        c.commit_operation(&operation, &receipt)?;
        Ok(receipt)
    })
}
