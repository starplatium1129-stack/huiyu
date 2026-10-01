use super::*;
use canonical::{entity_key, stringify};
use rusqlite::params;
use std::collections::HashSet;

fn rule_text(rule: &Value, field: &str, limit: usize) -> Result<String> {
    let value = string(rule, field)?.trim();
    if value.encode_utf16().count() > limit {
        return Err(invalid("Smart album condition is too long"));
    }
    Ok(value.to_owned())
}

pub(super) fn normalize_rule(rule: &Value) -> Result<Value> {
    if !rule.is_object() {
        return Err(invalid("Smart album rule must be an object"));
    }
    let tags = rule["tags"]
        .as_array()
        .filter(|tags| tags.len() <= 64)
        .ok_or_else(|| invalid("Smart album tags must contain at most 64 strings"))?;
    let mut normalized = Vec::new();
    for tag in tags {
        let tag = tag
            .as_str()
            .map(str::trim)
            .filter(|tag| !tag.is_empty() && tag.encode_utf16().count() <= 64)
            .ok_or_else(|| invalid("Smart album tags must contain 1–64 characters"))?;
        if !normalized.iter().any(|value| value == tag) {
            normalized.push(tag.to_owned());
        }
    }
    let tag_match = string(rule, "tagMatch")?;
    if !matches!(tag_match, "all" | "any") || !rule["favoriteOnly"].is_boolean() {
        return Err(invalid("Smart album conditions are invalid"));
    }
    Ok(
        json!({"characterId":rule_text(rule,"characterId",200)?,"tags":normalized,
        "tagMatch":tag_match,"favoriteOnly":rule["favoriteOnly"],
        "search":rule_text(rule,"search",500)?,"projectId":rule_text(rule,"projectId",200)?}),
    )
}

pub(super) fn save(c: &Context, command: &Value, revision: i64, receipt: &mut Value) -> Result<()> {
    let mut body = command["project"].clone();
    if !body.is_object() {
        return Err(invalid("Project body must be an object"));
    }
    let key = entity_key(&body["id"])?;
    let current = records::project(c, &key)?;
    if current
        .as_ref()
        .map(|p| &p["revision"])
        .unwrap_or(&Value::Null)
        != &command["expectedRevision"]
    {
        return Err(conflict(
            "REVISION_CONFLICT",
            "Project has a newer revision",
        ));
    }
    let keys = command["artworkIds"]
        .as_array()
        .ok_or_else(|| invalid("Project artwork IDs must be an array"))?
        .iter()
        .map(entity_key)
        .collect::<Result<Vec<_>>>()?;
    if keys.iter().collect::<HashSet<_>>().len() != keys.len() {
        return Err(invalid("Project contains duplicate artworks"));
    }
    let smart = body.get("smartRule").is_some();
    if let Some(current) = &current {
        if current["body"].get("smartRule").is_some() != smart {
            return Err(conflict(
                "PROJECT_KIND_CONFLICT",
                "Manual and smart albums cannot replace each other",
            ));
        }
        body["id"] = current["id"].clone();
    }
    if smart {
        if !keys.is_empty() {
            return Err(invalid(
                "Smart albums cannot have manual artwork membership",
            ));
        }
        let rule = normalize_rule(&body["smartRule"])?;
        let title = string(&body, "title")?.trim().to_owned();
        if title.is_empty() || title.encode_utf16().count() > 120 {
            return Err(invalid("Smart album title must contain 1–120 characters"));
        }
        let manual = string(&rule, "projectId")?;
        if !manual.is_empty() {
            let project = records::project(c, manual)?;
            if manual == key || project.is_none_or(|row| row["body"].get("smartRule").is_some()) {
                return Err(invalid(
                    "Smart albums can only filter an existing manual album",
                ));
            }
        }
        // Older clients can edit known fields without erasing newer project metadata.
        if let Some(current) = &current {
            let mut previous = current["body"]
                .as_object()
                .cloned()
                .ok_or_else(|| invalid("Stored project body is invalid"))?;
            previous.extend(body.as_object().unwrap().clone());
            body = Value::Object(previous);
        }
        body["title"] = title.into();
        body["smartRule"] = rule;
        body["history_ids"] = json!([]);
    }
    c.db.execute("INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(id_key) DO UPDATE SET body=excluded.body,revision=excluded.revision",
        params![key,stringify(&body["id"]),stringify(&body),revision])?;
    records::update_membership(c, &key, &keys, revision)?;
    receipt["project"] = records::project(c, &key)?.unwrap();
    Ok(())
}

pub(super) fn delete_smart(c: &Context, command: &Value, receipt: &mut Value) -> Result<()> {
    let key = entity_key(&command["id"])?;
    let current = records::project(c, &key)?;
    receipt["id"] = command["id"].clone();
    let Some(current) = current else {
        receipt["deleted"] = false.into();
        return Ok(());
    };
    if current["revision"] != command["expectedRevision"] {
        return Err(conflict(
            "REVISION_CONFLICT",
            "Project has a newer revision",
        ));
    }
    normalize_rule(
        current["body"]
            .get("smartRule")
            .ok_or_else(|| invalid("Only a smart album can be deleted"))?,
    )?;
    // Cascading references belong to this album only. Artworks and media are untouched.
    c.db.execute("DELETE FROM projects WHERE id_key=?", [key])?;
    receipt["id"] = current["id"].clone();
    receipt["deleted"] = true.into();
    Ok(())
}
