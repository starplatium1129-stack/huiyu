use super::{
    Error, Result, Value, fs, json,
    paths::Paths,
    release::{self, Release},
};
use crate::resources::{
    digest, equal,
    lifecycle::{Operation, copy},
    manifest::{self, Entry, Manifest},
};
use std::{collections::HashMap, path::Path};

pub(super) fn initialize(paths: &Paths) -> Result<()> {
    fs::ensure(&paths.showcase)?;
    let marker = paths.showcase.join("store.json");
    let expected = json!({"schemaVersion":1,"kind":"huiyu-showcase-library"});
    match fs::json(&marker, true, false)? {
        Some(value) if !equal(&value, &expected) => {
            return Err(Error::new("UNOWNED_ROOT", "Unknown showcase store marker"));
        }
        Some(_) => {}
        None => {
            if std::fs::read_dir(&paths.showcase)?.next().is_some() {
                return Err(Error::new(
                    "UNOWNED_ROOT",
                    "Refusing nonempty unowned showcase store",
                ));
            }
            fs::write_json(&marker, &expected)?;
        }
    }
    fs::ensure(&paths.showcase.join("editions"))
}
fn seed(root: &Path) -> Result<(Value, HashMap<String, Entry>)> {
    let value = fs::json(&root.join(".offline-seed.json"), false, false)?.unwrap();
    let files: Vec<Entry> = serde_json::from_value(value["entries"].clone())
        .map_err(|_| Error::new("STATE_INVALID", "Invalid showcase seed inventory"))?;
    let inventory = Manifest {
        entries: files.clone(),
    };
    if value["schemaVersion"] != 1
        || value["kind"] != "huiyu-showcase-seed"
        || inventory.identity() != value["contentIdentity"]
        || files
            .iter()
            .any(|entry| entry.path != "manifest.json" && !release::media(&entry.path))
    {
        return Err(Error::new("STATE_INVALID", "Invalid showcase baseline"));
    }
    let original = value["manifestRaw"]
        .as_str()
        .ok_or_else(|| Error::new("STATE_INVALID", "Missing original showcase manifest bytes"))?;
    let declared = files
        .iter()
        .find(|entry| entry.path == "manifest.json")
        .ok_or_else(|| Error::new("STATE_INVALID", "Showcase baseline omits display manifest"))?;
    if original.len() as u64 != declared.bytes
        || digest(original.as_bytes()) != declared.sha256
        || serde_json::from_str::<Value>(original)
            .ok()
            .is_none_or(|parsed| !equal(&parsed, &value["manifest"]))
    {
        return Err(Error::new(
            "STATE_INVALID",
            "Showcase baseline metadata differs from its approved file hash",
        ));
    }
    release::display(&value["manifest"])?;
    Ok((
        value,
        files
            .into_iter()
            .map(|entry| (entry.path.clone(), entry))
            .collect(),
    ))
}
fn bytes_entry(root: &Path, name: &str) -> Result<Entry> {
    fs::relative(name)?;
    let bytes = fs::bytes(&fs::child(root, name)?, 32 * 1024 * 1024, false)?;
    Ok(Entry {
        path: name.into(),
        bytes: bytes.len() as u64,
        sha256: digest(bytes),
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
        copy::entry(op, old, target, parts, &bytes_entry(old, &name)?)?;
        count += 1;
    }
    fs::write_json(&target.join("home-hero.json"), &value)?;
    Ok(count)
}
fn merge(
    op: &Operation,
    old: &Path,
    target: &Path,
    parts: &Path,
    release: &Release,
    identity: &Value,
) -> Result<usize> {
    let (seed, hashes) = seed(old)?;
    if seed["contentIdentity"] != *identity {
        return Err(Error::new(
            "STATE_INVALID",
            "Showcase seed differs from the installed edition pointer",
        ));
    }
    let original = release::display(&seed["manifest"])?;
    let local_raw = fs::json(&old.join("manifest.json"), false, false)?.unwrap();
    let local = release::display(&local_raw)?;
    let mut output = release.display.clone();
    let mut entries = output["entries"].as_array().unwrap().clone();
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
        let item = local.get(&id);
        let mut modified = !release::same_entry(item, original.get(&id));
        if let Some(item) = item {
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
        let index = entries.iter().position(|entry| {
            entry["id"]
                .as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(&id))
        });
        if let Some(item) = item {
            for field in ["image", "thumb"] {
                copy::entry(
                    op,
                    old,
                    target,
                    parts,
                    &bytes_entry(old, item[field].as_str().unwrap())?,
                )?;
            }
            if let Some(index) = index {
                entries[index] = item.clone();
            } else {
                entries.push(item.clone());
            }
        } else if let Some(index) = index {
            entries.remove(index);
        }
    }
    let mut metadata_changed = false;
    for (key, value) in local_raw.as_object().unwrap() {
        if ["entries", "entryCount", "sceneCount", "counts"].contains(&key.as_str()) {
            continue;
        }
        if seed["manifest"]
            .get(key)
            .is_none_or(|seed| !equal(seed, value))
        {
            output[key] = value.clone();
            metadata_changed = true;
        }
    }
    if preserved > 0 || metadata_changed {
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
        output["entries"] = json!(entries);
        fs::write_json(&target.join("manifest.json"), &output)?;
    }
    preserved += preserve_home(op, old, target, parts)?;
    Ok(preserved)
}
fn inventory(root: &Path) -> Result<Manifest> {
    fn visit(root: &Path, folder: &Path, entries: &mut Vec<Entry>) -> Result<()> {
        fs::safe(folder, false, false)?;
        for item in std::fs::read_dir(folder)? {
            let path = item?.path();
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if [".offline-seed.json", ".offline-ready.json"].contains(&relative.as_str()) {
                continue;
            }
            let stat = fs::safe(&path, false, false)?.unwrap();
            if stat.is_dir() {
                visit(root, &path, entries)?;
            } else if relative == "manifest.json"
                || release::media(&relative)
                || relative == "home-hero.json"
                || ["home/nene.jpg", "home/natsume.jpg"].contains(&relative.as_str())
            {
                entries.push(bytes_entry(root, &relative)?);
            } else {
                return Err(Error::new("UNLISTED_FILE", "Unknown local showcase file"));
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries)?;
    Ok(Manifest { entries })
}
pub(super) fn verify_ready(op: &Operation, root: &Path, release: &Release) -> Result<Value> {
    let value = fs::json(&root.join(".offline-ready.json"), false, false)?.unwrap();
    let entries: Vec<Entry> = serde_json::from_value(value["entries"].clone())
        .map_err(|_| Error::new("STATE_INVALID", "Invalid prepared showcase inventory"))?;
    let expected = Manifest { entries };
    if value["schemaVersion"] != 1
        || value["releaseSha256"] != release.approved["releaseSha256"]
        || expected.identity() != value["identity"]
        || seed(root)?.0["contentIdentity"] != release.showcase.identity()
    {
        return Err(Error::new(
            "STATE_INVALID",
            "Prepared showcase differs from approved release",
        ));
    }
    manifest::verify(
        root,
        &expected,
        &[".offline-seed.json", ".offline-ready.json"],
        &op.cancel,
    )?;
    Ok(value)
}
pub(super) fn prepare(
    op: &Operation,
    paths: &Paths,
    before: &Value,
    reference: &Value,
    release: &Release,
) -> Result<Value> {
    let destination = fs::child(&paths.showcase, reference["path"].as_str().unwrap())?;
    if fs::safe(&destination, true, false)?.is_some() {
        return verify_ready(op, &destination, release);
    }
    let nonce = reference["path"]
        .as_str()
        .unwrap()
        .strip_prefix("editions/")
        .unwrap();
    let staging = paths.showcase.join(format!(".building-{nonce}"));
    let parts = paths.showcase.join(format!(".parts-{nonce}"));
    fs::ensure(&staging)?;
    let result = (|| {
        for entry in &release.showcase.entries {
            copy::entry(op, &release.showcase_root, &staging, &parts, entry)?;
        }
        let preserved = paths
            .current_root(before)?
            .map(|old| {
                merge(
                    op,
                    &old,
                    &staging,
                    &parts,
                    release,
                    &before["current"]["contentIdentity"],
                )
            })
            .transpose()?
            .unwrap_or(0);
        let manifest_raw = String::from_utf8(fs::bytes(
            &release.showcase_root.join("manifest.json"),
            fs::MAX_JSON,
            false,
        )?)
        .map_err(|_| Error::new("MANIFEST_INVALID", "Showcase manifest must be UTF8"))?;
        fs::write_json(
            &staging.join(".offline-seed.json"),
            &json!({"schemaVersion":1,"kind":"huiyu-showcase-seed","releaseSha256":release.approved["releaseSha256"],"contentIdentity":release.showcase.identity(),"entries":release.showcase.entries,"manifest":release.display,"manifestRaw":manifest_raw}),
        )?;
        let installed = inventory(&staging)?;
        let ready = json!({"schemaVersion":1,"releaseSha256":release.approved["releaseSha256"],"identity":installed.identity(),"entries":installed.entries,"preservedLocalEntries":preserved});
        fs::write_json(&staging.join(".offline-ready.json"), &ready)?;
        verify_ready(op, &staging, release)?;
        op.check()?;
        fs::safe(&destination, true, false)?;
        std::fs::rename(&staging, &destination)?;
        fs::sync(destination.parent().unwrap())?;
        Ok(ready)
    })();
    // Incomplete staging is retained for diagnosis; it is never selected by the pointer.
    if fs::safe(&parts, true, false)?.is_some() && std::fs::read_dir(&parts)?.next().is_none() {
        std::fs::remove_dir(&parts)?;
    }
    result
}
