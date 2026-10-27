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
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Read, path::Path};
use tokio_util::sync::CancellationToken;

/// Installed showcases are editable. Check their current references, rather
/// than the original release hashes, before reporting a complete installation.
pub(super) fn verify_current(root: &Path, cancel: &CancellationToken) -> Result<()> {
    super::config::cancelled(cancel)?;
    let value = fs::json(&root.join("manifest.json"), false, false)
        .map_err(|error| {
            Error::new(
                &error.code,
                "当前样张库清单无法读取，请检查 manifest.json；尚未确认安装完整。",
            )
        })?
        .unwrap();
    let entries = release::display(&value).map_err(|error| {
        Error::new(
            &error.code,
            "当前样张库清单或图片路径无效，请检查 manifest.json；尚未确认安装完整。",
        )
    })?;
    for item in entries.values() {
        super::config::cancelled(cancel)?;
        for field in ["image", "thumb"] {
            let name = item[field].as_str().unwrap();
            if fs::safe(&fs::child(root, name)?, true, false)?.is_none_or(|file| !file.is_file()) {
                return Err(Error::new(
                    "CONTENT_INVALID",
                    format!("当前样张库引用的图片缺失或不是普通文件：{name}；尚未确认安装完整。"),
                ));
            }
        }
    }
    Ok(())
}

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
fn seed(root: &Path) -> Result<(Value, Vec<Entry>)> {
    let value = fs::json(&root.join(".offline-seed.json"), false, false)?.unwrap();
    let inventory = Manifest {
        entries: serde::Deserialize::deserialize(&value["entries"])
            .map_err(|_| Error::new("STATE_INVALID", "Invalid showcase seed inventory"))?,
    };
    if value["schemaVersion"] != 1
        || value["kind"] != "huiyu-showcase-seed"
        || inventory.identity() != value["contentIdentity"]
        || inventory
            .entries
            .iter()
            .any(|entry| entry.path != "manifest.json" && !release::media(&entry.path))
    {
        return Err(Error::new("STATE_INVALID", "Invalid showcase baseline"));
    }
    let original = value["manifestRaw"]
        .as_str()
        .ok_or_else(|| Error::new("STATE_INVALID", "Missing original showcase manifest bytes"))?;
    let declared = inventory
        .entries
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
    Ok((value, inventory.entries))
}
pub(super) fn baseline(paths: &Paths, release: &Release) -> Result<()> {
    let Some(base) = &release.baseline else {
        return Ok(());
    };
    let pointer = paths.pointer()?;
    if pointer["current"]["releaseSha256"] == release.approved["releaseSha256"] {
        return Ok(());
    }
    if pointer["current"].is_null() {
        return Err(Error::new(
            "BASELINE_REQUIRED",
            "增量包不能用于首次安装，请先安装完整资源包。",
        ));
    }
    if pointer["current"]["releaseSha256"] != base["releaseSha256"]
        || pointer["current"]["contentIdentity"] != base["showcaseIdentity"]
    {
        return Err(Error::new(
            "BASELINE_MISMATCH",
            "增量资源包需要先安装对应的基础资源包；当前样张版本不匹配。",
        ));
    }
    let old = paths.current_root(&pointer)?.ok_or_else(|| {
        Error::new(
            "BASELINE_REQUIRED",
            "增量包不能用于首次安装，请先安装完整资源包。",
        )
    })?;
    let (seed, files) = seed(&old)?;
    if seed["contentIdentity"] != base["showcaseIdentity"]
        || seed["releaseSha256"] != base["releaseSha256"]
    {
        return Err(Error::new(
            "BASELINE_MISMATCH",
            "已安装样张基线与增量包不匹配。",
        ));
    }
    let hashes: HashMap<_, _> = files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let payload = release
        .showcase_payload()
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<std::collections::HashSet<_>>();
    for entry in &release.showcase.entries {
        if !payload.contains(entry.path.as_str())
            && hashes.get(entry.path.as_str()).copied() != Some(entry)
        {
            return Err(Error::new(
                "MANIFEST_INVALID",
                "增量包缺少新增或变化的样张文件。",
            ));
        }
    }
    Ok(())
}
fn bytes_entry(op: &Operation, root: &Path, name: &str) -> Result<Entry> {
    super::config::cancelled(&op.cancel)?;
    fs::relative(name)?;
    const LIMIT: u64 = 32 * 1024 * 1024;
    let mut input = fs::open(&fs::child(root, name)?, LIMIT, false)?.take(LIMIT + 1);
    let mut buffer = vec![0; 512 * 1024];
    let mut hash = Sha256::new();
    let mut bytes = 0;
    loop {
        super::config::cancelled(&op.cancel)?;
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
    super::config::cancelled(&op.cancel)?;
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
fn merge(
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
fn inventory(op: &Operation, root: &Path) -> Result<Manifest> {
    fn visit(op: &Operation, root: &Path, folder: &Path, entries: &mut Vec<Entry>) -> Result<()> {
        super::config::cancelled(&op.cancel)?;
        fs::safe(folder, false, false)?;
        for item in std::fs::read_dir(folder)? {
            super::config::cancelled(&op.cancel)?;
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
                visit(op, root, &path, entries)?;
            } else if relative == "manifest.json"
                || release::media(&relative)
                || relative == "home-hero.json"
                || ["home/nene.jpg", "home/natsume.jpg"].contains(&relative.as_str())
            {
                entries.push(bytes_entry(op, root, &relative)?);
            } else {
                return Err(Error::new("UNLISTED_FILE", "Unknown local showcase file"));
            }
        }
        super::config::cancelled(&op.cancel)
    }
    let mut entries = Vec::new();
    visit(op, root, root, &mut entries)?;
    Ok(Manifest { entries })
}
pub(super) fn verify_ready(op: &Operation, root: &Path, release: &Release) -> Result<Value> {
    let value = fs::json(&root.join(".offline-ready.json"), false, false)?.unwrap();
    let entries: Vec<Entry> = serde::Deserialize::deserialize(&value["entries"])
        .map_err(|_| Error::new("STATE_INVALID", "Invalid prepared showcase inventory"))?;
    let expected = Manifest { entries };
    if value["schemaVersion"] != 1
        || value["releaseSha256"] != release.approved["releaseSha256"]
        || expected.identity() != value["identity"]
        || seed(root)?.0["contentIdentity"] != release.showcase_identity()
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
        let old = paths.current_root(before)?;
        let payload = release
            .showcase_payload()
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<std::collections::HashSet<_>>();
        for entry in &release.showcase.entries {
            if payload.contains(entry.path.as_str()) {
                copy::entry(op, &release.showcase_root, &staging, &parts, entry)?;
            } else {
                let source = old.as_ref().ok_or_else(|| {
                    Error::new("BASELINE_REQUIRED", "Missing installed sample baseline")
                })?;
                if fs::safe(&fs::child(source, &entry.path)?, true, false)?.is_some() {
                    // Local artwork may differ from the release seed. Snapshot
                    // those bytes here; merge below preserves its entry/deletion.
                    copy::entry(
                        op,
                        source,
                        &staging,
                        &parts,
                        &bytes_entry(op, source, &entry.path)?,
                    )?;
                }
            }
        }
        let preserved = old
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
        {
            let mut seed = json!({"schemaVersion":1,"kind":"huiyu-showcase-seed","releaseSha256":release.approved["releaseSha256"],"contentIdentity":release.showcase_identity(),"entries":release.showcase.entries,"manifest":null,"manifestRaw":null});
            seed["manifestRaw"] = manifest_raw.into();
            let mut body = crate::storage::stringify_object(seed.as_object().unwrap().iter().map(
                |(key, value)| {
                    (
                        key,
                        if key == "manifest" {
                            &release.display
                        } else {
                            value
                        },
                    )
                },
            ));
            body.push('\n');
            drop(seed);
            fs::atomic(&staging.join(".offline-seed.json"), body.as_bytes())?;
        }
        let installed = inventory(op, &staging)?;
        let mut ready = json!({"schemaVersion":1,"releaseSha256":release.approved["releaseSha256"],"identity":installed.identity(),"entries":null,"preservedLocalEntries":preserved});
        ready["entries"] = Value::Array(
            installed
                .entries
                .into_iter()
                .map(|entry| {
                    let mut value = json!({"path":null,"bytes":entry.bytes,"sha256":null});
                    value["path"] = entry.path.into();
                    value["sha256"] = entry.sha256.into();
                    value
                })
                .collect(),
        );
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
