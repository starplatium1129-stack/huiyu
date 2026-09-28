use super::*;
use std::collections::{HashMap, HashSet};
fn space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn text<'a>(value: &'a Value, label: &str) -> Result<&'a str> {
    value
        .as_str()
        .filter(|value| !value.trim_matches(space).is_empty())
        .ok_or_else(|| invalid(format!("{label} must be a non-empty string")))
}
fn record<'a>(value: &'a Value, label: &str) -> Result<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{label} must be an object")))
}
fn key(value: &str) -> Result<String> {
    let mut output = String::new();
    let mut gap = false;
    for c in value.trim_matches(space).to_lowercase().chars() {
        if space(c) || ['-', '/'].contains(&c) {
            if !gap {
                output.push('_');
            }
            gap = true;
        } else {
            output.push(c);
            gap = false;
        }
    }
    if ["__proto__", "prototype", "constructor"].contains(&output.as_str()) {
        return Err(invalid(format!("Reserved tag key: {output}")));
    }
    Ok(output)
}
fn members(actual: Vec<&str>, expected: &Value) -> bool {
    let Some(items) = expected.as_array() else {
        return false;
    };
    let Some(items) = items.iter().map(Value::as_str).collect::<Option<Vec<_>>>() else {
        return false;
    };
    let expected = items.iter().copied().collect::<HashSet<_>>();
    expected.len() == items.len() && actual.iter().copied().collect::<HashSet<_>>() == expected
}
fn validate_manifest(value: &Value) -> Result<()> {
    let files = value["files"]
        .as_array()
        .filter(|files| value["version"] == 1 && !files.is_empty())
        .ok_or_else(|| invalid("Tag manifest must have version 1 and a non-empty files array"))?;
    let (mut names, mut categories) = (HashSet::new(), HashSet::new());
    for entry in files {
        record(entry, "Tag manifest entry")?;
        let file = text(&entry["file"], "Tag shard file")?;
        let category = text(&entry["category"], "Tag shard category")?;
        let lower = file.to_lowercase();
        let stem = if lower.ends_with(".json") {
            &file[..file.len() - 5]
        } else {
            ""
        };
        let lower_stem = lower.trim_end_matches(".json");
        if !lower.ends_with(".json")
            || stem.is_empty()
            || !stem
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !stem
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            || lower == "manifest.json"
            || ["con", "prn", "aux", "nul"].contains(&lower_stem)
            || ["com", "lpt"].iter().any(|prefix| {
                lower_stem.strip_prefix(prefix).is_some_and(|number| {
                    number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9')
                })
            })
        {
            return Err(invalid(format!("Unsafe tag shard filename: {file}")));
        }
        if !names.insert(lower) {
            return Err(invalid(format!("Duplicate tag shard file: {file}")));
        }
        if !categories.insert(category.to_lowercase()) {
            return Err(invalid(format!("Duplicate tag category: {category}")));
        }
        if category != category.trim_matches(space) {
            return Err(invalid(format!("Untrimmed tag category: {category}")));
        }
        if !entry["count"]
            .as_f64()
            .is_some_and(|number| number.is_finite() && number >= 0.0 && number.fract() == 0.0)
        {
            return Err(invalid(format!("Invalid tag count: {file}")));
        }
        if let Some(label) = entry.get("label") {
            text(label, &format!("{file} label"))?;
        }
    }
    if let Some(policy) = value.get("dictionary") {
        record(policy, "Tag dictionary policy")?;
        for field in ["duplicates", "aliasOverrides"] {
            if let Some(value) = policy.get(field) {
                record(value, &format!("Tag dictionary {field}"))?;
            }
        }
    }
    Ok(())
}
pub(super) fn dictionary(tags: &[Value], policy: &Value) -> Result<Value> {
    record(policy, "Tag dictionary policy")?;
    let mut by_id = HashMap::new();
    let mut groups: HashMap<String, Vec<&Value>> = HashMap::new();
    let mut keys = Vec::new();
    for tag in tags {
        record(tag, "Tag entry")?;
        for field in ["id", "cat", "en", "cn"] {
            text(
                &tag[field],
                &format!("Tag {} {field}", tag["id"].as_str().unwrap_or("?")),
            )?;
        }
        let id = tag["id"].as_str().unwrap();
        let category = tag["cat"].as_str().unwrap();
        if id != id.trim_matches(space) || category != category.trim_matches(space) {
            return Err(invalid(format!("Untrimmed tag ID/category: {id}")));
        }
        if by_id.insert(id, tag).is_some() {
            return Err(invalid(format!("Duplicate tag ID: {id}")));
        }
        if let Some(weight) = tag.get("weight")
            && weight
                .as_f64()
                .is_none_or(|weight| !weight.is_finite() || weight < 0.0)
        {
            return Err(invalid(format!("Invalid tag weight: {id}")));
        }
        if tag.get("desc").is_some_and(|value| !value.is_string()) {
            return Err(invalid(format!("Invalid tag description: {id}")));
        }
        for field in ["aliases", "related"] {
            if let Some(value) = tag.get(field) {
                let values = value
                    .as_array()
                    .ok_or_else(|| invalid(format!("Tag {id} {field} must be an array")))?;
                for value in values {
                    text(value, &format!("Tag {id} {field}"))?;
                }
            }
        }
        let key = key(tag["en"].as_str().unwrap())?;
        if !groups.contains_key(&key) {
            keys.push(key.clone());
        }
        groups.entry(key).or_default().push(tag);
    }
    let mut meanings = serde_json::Map::new();
    let mut canonical = HashMap::new();
    let mut used_duplicates = HashSet::new();
    for key in &keys {
        let group = &groups[key];
        let mut chosen = group[0];
        if group.len() > 1 {
            let decision = &policy["duplicates"][key];
            if !members(
                group
                    .iter()
                    .map(|tag| tag["id"].as_str().unwrap())
                    .collect(),
                &decision["members"],
            ) {
                return Err(invalid(format!(
                    "Unresolved duplicate tag: {key} ({})",
                    group
                        .iter()
                        .map(|tag| tag["id"].as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
            chosen = group
                .iter()
                .find(|tag| tag["id"] == decision["canonical"])
                .copied()
                .ok_or_else(|| invalid(format!("Invalid canonical tag: {key}")))?;
            if let Some(meaning) = decision.get("meaning") {
                text(meaning, &format!("Canonical meaning {key}"))?;
            }
            used_duplicates.insert(key.as_str());
        }
        canonical.insert(key.clone(), chosen);
        meanings.insert(
            key.clone(),
            policy["duplicates"][key]
                .get("meaning")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or_else(|| chosen["cn"].clone()),
        );
    }
    if let Some(duplicates) = policy["duplicates"].as_object() {
        for key in duplicates.keys() {
            if !used_duplicates.contains(key.as_str()) {
                return Err(invalid(format!("Stale duplicate tag decision: {key}")));
            }
        }
    }
    let mut aliases = serde_json::Map::new();
    let mut owners: HashMap<String, String> = HashMap::new();
    let mut used_overrides = HashSet::new();
    for tag in tags {
        let id = tag["id"].as_str().unwrap();
        if let Some(related) = tag["related"].as_array() {
            for related in related {
                let related = related.as_str().unwrap();
                if !by_id.contains_key(related) {
                    return Err(invalid(format!(
                        "Tag {id} references unknown related ID: {related}"
                    )));
                }
            }
        }
        let owner = key(tag["en"].as_str().unwrap())?;
        if let Some(values) = tag["aliases"].as_array() {
            for alias in values {
                let alias = alias.as_str().unwrap();
                let key = key(alias)?;
                if key == owner {
                    continue;
                }
                if owners.get(&key).is_some_and(|before| before != &owner) {
                    return Err(invalid(format!("Ambiguous tag alias: {alias}")));
                }
                if let Some(shadowed) = groups.get(&key) {
                    let decision = &policy["aliasOverrides"][&key];
                    if !members(
                        shadowed
                            .iter()
                            .map(|tag| tag["id"].as_str().unwrap())
                            .collect(),
                        &decision["shadowed"],
                    ) || decision["target"]
                        .as_str()
                        .and_then(|target| by_id.get(target))
                        .is_none_or(|target| target["en"] != tag["en"])
                    {
                        return Err(invalid(format!(
                            "Alias shadows a canonical tag without a decision: {alias}"
                        )));
                    }
                    used_overrides.insert(key.clone());
                }
                owners.insert(key.clone(), owner.clone());
                aliases.insert(key, canonical[&owner]["en"].clone());
            }
        }
    }
    if let Some(overrides) = policy["aliasOverrides"].as_object() {
        for key in overrides.keys() {
            if !used_overrides.contains(key) {
                return Err(invalid(format!("Stale alias override: {key}")));
            }
        }
    }
    Ok(json!({"version":1,"meanings":meanings,"aliases":aliases}))
}
pub(super) fn load(root: &Path) -> Result<(Vec<Value>, Value)> {
    let directory = root.join("data/tags");
    let manifest = fs::json(&directory.join("manifest.json"))?;
    validate_manifest(&manifest)?;
    let mut tags = Vec::new();
    for entry in manifest["files"].as_array().unwrap() {
        let file = entry["file"].as_str().unwrap();
        let shard = fs::json(&directory.join(file))?;
        let values = shard["tags"].as_array().ok_or_else(|| {
            invalid(format!(
                "{file} version/category/count does not match the manifest"
            ))
        })?;
        if shard["version"] != 1
            || shard["category"] != entry["category"]
            || entry["count"].as_f64() != Some(values.len() as f64)
            || values.iter().any(|tag| tag["cat"] != entry["category"])
        {
            return Err(invalid(format!(
                "{file} version/category/count does not match the manifest"
            )));
        }
        tags.extend(values.iter().cloned());
    }
    let dict = dictionary(&tags, manifest.get("dictionary").unwrap_or(&json!({})))?;
    Ok((tags, dict))
}
