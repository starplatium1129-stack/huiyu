use super::*;
use crate::{config::Config, maintenance::fs};
use serde_json::json;
use std::{io::Write, path::Path};
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
    if disk(fs::safe(&file, false, true))?.is_some_and(|m| m.len() > 1024 * 1024) {
        return Err(corrupt());
    }
    let Some(bytes) = disk(fs::read(&file, true))? else {
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
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(&path).map_err(|error| {
        if matches!(error.raw_os_error(), Some(32 | 33))
            || error.kind() == std::io::ErrorKind::WouldBlock
        {
            busy()
        } else {
            corrupt()
        }
    })?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: the descriptor is owned by file and remains live for this call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(busy());
        }
    }
    Ok(file)
}
pub(super) fn save(config: &Config, body: &Value, cancel: &CancellationToken) -> Result<Value> {
    let started = Instant::now();
    let id = body["id"]
        .as_str()
        .filter(|id| id_ok(id))
        .ok_or_else(|| invalid("角色 ID 无效"))?;
    let characters: Value = serde_json::from_slice(
        &disk(fs::read(
            &config.content_root().join("data/characters.json"),
            false,
        ))?
        .ok_or_else(corrupt)?,
    )
    .map_err(|_| corrupt())?;
    if !characters
        .as_array()
        .is_some_and(|rows| rows.iter().any(|row| row["id"] == id))
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
        manifest["entries"].as_object_mut().unwrap().remove(id);
    } else {
        let image = body["image"].as_str().ok_or_else(|| invalid("缺少图片"))?;
        let art = derive::build(id, image, cancel, started)?;
        let character = root.join(id);
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
            ("portrait.png", &art.portrait),
            ("thumbnail.png", &art.thumbnail),
            ("particles.json", &art.particles),
        ] {
            if let Some(staged) = &staged {
                let mut out = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(staged.path().join(name))?;
                out.write_all(bytes)?;
                out.sync_all()?;
            } else if disk(fs::read(&directory.join(name), false))?.as_deref()
                != Some(bytes.as_slice())
            {
                return Err(corrupt());
            }
            hashes[name] = derive::hash(bytes).into();
            check(cancel, started)?;
        }
        if let Some(staged) = staged {
            disk(fs::safe(&directory, true, true))?;
            std::fs::rename(staged.path(), &directory)?;
            disk(fs::sync(&character))?;
        }
        let prefix = format!("/api/character-art/{id}/{}", art.revision);
        manifest["entries"][id] = json!({"revision":art.revision,"sourceSha256":art.revision,"portraitUrl":format!("{prefix}/portrait.png"),"thumbnailUrl":format!("{prefix}/thumbnail.png"),"particleUrl":format!("{prefix}/particles.json"),"width":art.width,"height":art.height,"hasTransparency":art.transparent,"hashes":hashes});
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
    let metadata = disk(fs::safe(&path, false, false))?.ok_or_else(corrupt)?;
    if metadata.len() > 140 * 1024 * 1024 {
        return Err(corrupt());
    }
    let bytes = disk(fs::read(&path, false))?.ok_or_else(corrupt)?;
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
