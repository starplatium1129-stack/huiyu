use super::*;
use crate::{config::Config, maintenance::fs};
use serde_json::json;
use std::{
    io::{Read, Write},
    path::Path,
};
fn disk<T>(value: crate::maintenance::Result<T>) -> Result<T> {
    value.map_err(|_| corrupt())
}
fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn revision_ok(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
pub(super) fn read(root: &Path) -> Result<Value> {
    let file = root.join("manifest.json");
    let Some(bytes) = disk(fs::read_limited(&file, true, Some(1024 * 1024)))? else {
        return Ok(json!({"ok":true,"version":"0","entries":{}}));
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| corrupt())?;
    if value["ok"] != true || value["version"].as_str().is_none_or(|v| !revision_ok(v)) {
        return Err(corrupt());
    }
    let entries = value["entries"].as_object().ok_or_else(corrupt)?;
    for (id, entry) in entries {
        if !id_ok(id)
            || entry["revision"].as_str().is_none_or(|v| !revision_ok(v))
            || entry["sourceSha256"] != entry["revision"]
        {
            return Err(corrupt());
        }
        let prefix = format!(
            "/api/character-art/{id}/{}",
            entry["revision"].as_str().unwrap()
        );
        if entry["width"].as_u64().is_none_or(|v| v == 0 || v > 8192)
            || entry["height"].as_u64().is_none_or(|v| v == 0 || v > 8192)
            || !entry["hasTransparency"].is_boolean()
        {
            return Err(corrupt());
        }
        for (key, name) in [
            ("portraitUrl", "portrait.png"),
            ("thumbnailUrl", "thumbnail.png"),
            ("particleUrl", "particles.json"),
        ] {
            if entry[key] != format!("{prefix}/{name}") {
                return Err(corrupt());
            }
        }
        for name in ["portrait.png", "thumbnail.png", "particles.json"] {
            if entry["hashes"][name]
                .as_str()
                .is_none_or(|v| !revision_ok(v))
            {
                return Err(corrupt());
            }
        }
    }
    Ok(value)
}
fn busy() -> ApiError {
    ApiError::new(
        409,
        "CHARACTER_ART_BUSY",
        "另一项头像保存正在执行，请稍后重试",
    )
}
pub(super) fn lock(root: &Path) -> Result<std::fs::File> {
    let path = root.join("write.lock");
    // Never unlink this inode: the OS-held lock is released on process exit.
    // An exclusively opened Windows lock may also block identity inspection.
    fs::safe(&path, false, true).map_err(|_| busy())?;
    crate::file_lock::try_lock(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::WouldBlock {
            busy()
        } else {
            corrupt()
        }
    })
}
pub(super) fn save(config: &Config, mut body: Value, cancel: &CancellationToken) -> Result<Value> {
    let started = Instant::now();
    let id = body["id"]
        .as_str()
        .filter(|id| id_ok(id))
        .ok_or_else(|| invalid("角色 ID 无效"))?
        .to_owned();
    if !crate::catalog::Catalog::open(crate::catalog::Options::from_config(config))?
        .character_profile_exists(&id)?
    {
        return Err(invalid("未知角色"));
    }
    let root = config.runtime_root.join("character-art");
    disk(fs::ensure(&root))?;
    let _lock = lock(&root)?;
    let mut manifest = read(&root)?;
    if body["baseVersion"].as_str().is_none() || body["baseVersion"] != manifest["version"] {
        return Err(ApiError::new(
            409,
            "CHARACTER_ART_CONFLICT",
            "头像已更新，请刷新后重试",
        ));
    }
    if body["reset"] == true {
        if !body["image"].is_null() {
            return Err(invalid("重置不能同时上传图片"));
        }
        drop(body);
        manifest["entries"]
            .as_object_mut()
            .unwrap()
            .remove(id.as_str());
    } else {
        let Some(Value::String(image)) = body.get_mut("image").map(Value::take) else {
            return Err(invalid("缺少图片"));
        };
        drop(body);
        let art = derive::build(&id, image, cancel, started)?;
        let character = root.join(&id);
        disk(fs::ensure(&character))?;
        let directory = character.join(&art.revision);
        let existing = disk(fs::safe(&directory, true, true))?.is_some();
        let staged = if existing {
            None
        } else {
            Some(
                tempfile::Builder::new()
                    .prefix(".staging-")
                    .tempdir_in(&character)?,
            )
        };
        let mut hashes = json!({});
        for (name, bytes) in [
            ("portrait.png", art.portrait),
            ("thumbnail.png", art.thumbnail),
            ("particles.json", art.particles),
        ] {
            if let Some(staged) = &staged {
                let mut out = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(staged.path().join(name))?;
                out.write_all(&bytes)?;
                out.sync_all()?;
            } else if !disk(fs::with_file(&directory.join(name), false, |file, _| {
                let mut remaining = bytes.as_ref();
                let mut matches = true;
                let mut buffer = [0_u8; 64 * 1024];
                // Finish reading so I/O and identity errors precede mismatch.
                loop {
                    let count = match file.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => count,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => return Err(error.into()),
                    };
                    matches &= remaining.starts_with(&buffer[..count]);
                    remaining = remaining.get(count..).unwrap_or(&[]);
                }
                Ok(matches && remaining.is_empty())
            }))?
            .unwrap_or(false)
            {
                return Err(corrupt());
            }
            hashes[name] = derive::hash(&bytes).into();
            check(cancel, started)?;
        }
        if let Some(staged) = staged {
            disk(fs::safe(&directory, true, true))?;
            std::fs::rename(staged.path(), &directory)?;
            disk(fs::sync(&character))?;
        }
        let prefix = format!("/api/character-art/{id}/{}", art.revision);
        manifest["entries"][id.as_str()] = json!({"revision":art.revision,"sourceSha256":art.revision,"portraitUrl":format!("{prefix}/portrait.png"),"thumbnailUrl":format!("{prefix}/thumbnail.png"),"particleUrl":format!("{prefix}/particles.json"),"width":art.width,"height":art.height,"hasTransparency":art.transparent,"hashes":hashes});
    }
    check(cancel, started)?;
    // A fresh revision token prevents ABA after reset/re-upload of the same image.
    manifest["version"] = derive::hash(uuid::Uuid::new_v4().as_bytes()).into();
    disk(fs::write_json(&root.join("manifest.json"), &manifest))?;
    Ok(manifest)
}
pub(super) fn asset(
    root: &Path,
    id: &str,
    revision: &str,
    file: &str,
) -> Result<(Vec<u8>, &'static str)> {
    if !id_ok(id)
        || !revision_ok(revision)
        || !["portrait.png", "thumbnail.png", "particles.json"].contains(&file)
    {
        return Err(ApiError::new(404, "NOT_FOUND", "头像资源不存在"));
    }
    let manifest = read(root)?;
    let entry = &manifest["entries"][id];
    if entry["revision"] != revision {
        return Err(ApiError::new(404, "NOT_FOUND", "头像资源已更新"));
    }
    let path = root.join(id).join(revision).join(file);
    let bytes =
        disk(fs::read_limited(&path, false, Some(140 * 1024 * 1024)))?.ok_or_else(corrupt)?;
    if entry["hashes"][file] != derive::hash(&bytes) {
        return Err(corrupt());
    }
    Ok((
        bytes,
        if file == "particles.json" {
            "application/json"
        } else {
            "image/png"
        },
    ))
}
