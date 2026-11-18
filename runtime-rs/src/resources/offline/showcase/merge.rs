use super::*;
use crate::resources::offline::config;

pub(super) fn bytes_entry(op: &Operation, root: &Path, name: &str) -> Result<Entry> {
    config::cancelled(&op.cancel)?;
    fs::relative(name)?;
    const LIMIT: u64 = 32 * 1024 * 1024;
    let mut input = fs::open(&fs::child(root, name)?, LIMIT, false)?.take(LIMIT + 1);
    let mut buffer = vec![0; 512 * 1024];
    let mut hash = Sha256::new();
    let mut bytes = 0;
    loop {
        config::cancelled(&op.cancel)?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > LIMIT {
            return Err(Error::new("METADATA_INVALID", "File exceeds limit"));
        }
        hash.update(&buffer[..count]);
    }
    config::cancelled(&op.cancel)?;
    Ok(Entry {
        path: name.into(),
        bytes,
        sha256: hex::encode(hash.finalize()),
    })
}
fn preserve_home(op: &Operation, old: &Path, target: &Path, parts: &Path) -> Result<usize> {
    let Some(value) = fs::json(&old.join("home-hero.json"), true, false)? else {
        return Ok(0);
    };
    if !value["entries"].is_object() {
        return Err(Error::new(
            "STATE_INVALID",
            "Invalid local home artwork manifest",
        ));
    }
    let mut count = 0;
    for id in ["nene", "natsume"] {
        let item = &value["entries"][id];
        if item["source"] != "upload" {
            continue;
        }
        let name = format!("home/{id}.jpg");
        if item["image"] != name {
            return Err(Error::new(
                "STATE_INVALID",
                "Invalid local home artwork path",
            ));
        }
        copy::entry(op, old, target, parts, &bytes_entry(op, old, &name)?)?;
        count += 1;
    }
    fs::write_json(&target.join("home-hero.json"), &value)?;
    Ok(count)
}
pub(super) fn merge(
    op: &Operation,
    old: &Path,
    target: &Path,
    parts: &Path,
    release: &Release,
    identity: &Value,
) -> Result<usize> {
    let (seed, files) = seed(old)?;
    if seed["contentIdentity"] != *identity {
        return Err(Error::new(
            "STATE_INVALID",
            "Showcase seed differs from the installed edition pointer",
        ));
    }
    let hashes: HashMap<_, _> = files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let original = release::display(&seed["manifest"])?;
    let local_raw = fs::json(&old.join("manifest.json"), false, false)?.unwrap();
    let mut local = release::display(&local_raw)?;
    let mut output = None;
    let initial = || {
        let mut output = release.display.clone();
        let entries = std::mem::take(output["entries"].as_array_mut().unwrap());
        (output, entries)
    };
    let by_id = release.display["entries"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry["id"].as_str().unwrap().to_ascii_lowercase(), index))
        .collect::<HashMap<_, _>>();
    let mut names = original
        .keys()
        .chain(local.keys())
        .cloned()
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    let mut preserved = 0;
    for id in names {
        op.check()?;
        let item = local.remove(&id);
        let mut modified =
            !release::same_entry(item.as_deref(), original.get(&id).map(|item| item.as_ref()));
        if let Some(item) = &item {
            for field in ["image", "thumb"] {
                let name = item[field].as_str().unwrap();
                if let Some(entry) = hashes.get(name) {
                    if !fs::file_matches(&fs::child(old, name)?, entry, &op.cancel)? {
                        modified = true;
                    }
                } else {
                    modified = true;
                }
            }
        }
        if !modified {
            continue;
        }
        preserved += 1;
        let index = by_id.get(&id).copied();
        if let Some(item) = &item {
            for field in ["image", "thumb"] {
                copy::entry(
                    op,
                    old,
                    target,
                    parts,
                    &bytes_entry(op, old, item[field].as_str().unwrap())?,
                )?;
            }
        }
        let (_, entries) = output.get_or_insert_with(initial);
        if let Some(item) = item {
            let item = item.into_owned();
            if let Some(index) = index {
                entries[index] = item;
            } else {
                entries.push(item);
            }
        } else if let Some(index) = index {
            // Validated display entries are objects. Keep indices stable until
            // all unique, sorted IDs have been processed.
            entries[index] = Value::Null;
        }
    }
    for (key, value) in local_raw.as_object().unwrap() {
        if ["entries", "entryCount", "sceneCount", "counts"].contains(&key.as_str()) {
            continue;
        }
        if seed["manifest"]
            .get(key)
            .is_none_or(|seed| !equal(seed, value))
        {
            output.get_or_insert_with(initial).0[key] = value.clone();
        }
    }
    if let Some((mut output, mut entries)) = output {
        entries.retain(|entry| !entry.is_null());
        output["entryCount"] = json!(entries.len());
        output["sceneCount"] = json!(entries.len());
        if !output["counts"].is_object() {
            output["counts"] = json!({});
        }
        output["counts"]["popular"] = json!(
            entries
                .iter()
                .filter(|entry| entry["type"] == "popular")
                .count()
        );
        output["entries"] = Value::Array(entries);
        fs::write_json(&target.join("manifest.json"), &output)?;
    }
    preserved += preserve_home(op, old, target, parts)?;
    Ok(preserved)
}
