//! Only preparation from verified packages can establish a managed code baseline.
use crate::error::{ApiError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    archive_sha256: String,
    files: BTreeMap<String, String>,
}
type Stamp = (
    crate::file_identity::Identity,
    crate::file_identity::Version,
);
#[derive(Serialize, Deserialize)]
struct VerifiedFiles {
    root: String,
    manifest: String,
    files: BTreeMap<String, Stamp>,
}
fn stamp(file: &std::fs::File) -> std::io::Result<Stamp> {
    Ok((
        crate::file_identity::opened(file)?,
        crate::file_identity::Version::of(file)?,
    ))
}
fn save_cache(cache: &Path, verified: &VerifiedFiles) {
    let saved = (|| -> std::io::Result<()> {
        let mut temporary = tempfile::NamedTempFile::new_in(cache.parent().unwrap())?;
        temporary.write_all(&serde_json::to_vec(verified)?)?;
        temporary.persist(cache).map_err(|error| error.error)?;
        Ok(())
    })();
    if let Err(error) = saved {
        eprintln!("ComfyUI verification cache: {error}");
    }
}
fn digest(
    input: &mut std::fs::File,
    buffer: &mut [u8],
    cancel: &CancellationToken,
) -> Result<String> {
    let mut hash = Sha256::new();
    loop {
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "代码校验已取消"));
        }
        let bytes = input.read(buffer)?;
        if bytes == 0 {
            break;
        }
        hash.update(&buffer[..bytes]);
    }
    Ok(hex::encode(hash.finalize()))
}
// Called only by the installer after a successful fresh extraction from checked
// packages, while its setup permit is held. Never establish trust at startup.
pub(in crate::control) async fn establish(
    comfy: &Path,
    archive: &str,
    cancel: &CancellationToken,
    cache: &Path,
    progress: impl Fn(u64, u64, &str),
) -> Result<()> {
    let root = comfy.parent().ok_or_else(invalid)?.to_owned();
    let (archive, cancel, cache) = (archive.to_owned(), cancel.clone(), cache.to_owned());
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    progress(0, 0, "正在建立环境文件清单");
    let mut work = tokio::task::spawn_blocking(move || {
        let mut files = BTreeMap::new();
        scan(&root, "ComfyUI", &mut files, &cancel)?;
        scan(&root, "python_embeded", &mut files, &cancel)?;
        if !files.contains_key("ComfyUI/main.py")
            || !files.contains_key("python_embeded/python.exe")
        {
            return Err(invalid());
        }
        let mut manifest = Manifest {
            schema_version: 1,
            archive_sha256: archive,
            files: BTreeMap::new(),
        };
        let mut verified = VerifiedFiles {
            root: crate::file_paths::key(&root)?,
            manifest: String::new(),
            files: BTreeMap::new(),
        };
        let total = files.len() as u64;
        let mut reported = Instant::now() - Duration::from_secs(1);
        let mut buffer = vec![0; 1024 * 1024];
        for (index, (relative, path)) in files.into_iter().enumerate() {
            if reported.elapsed() >= Duration::from_millis(200) {
                let _ = send.send((index as u64, total, relative.clone()));
                reported = Instant::now();
            }
            let mut input = std::fs::File::open(&path)?;
            let before = stamp(&input).ok();
            let hash = digest(&mut input, &mut buffer, &cancel)?;
            if let Some(before) = before {
                if stamp(&input)? != before
                    || std::fs::File::open(&path).and_then(|file| stamp(&file))? != before
                {
                    return Err(invalid());
                }
                verified.files.insert(relative.clone(), before);
            }
            manifest.files.insert(relative, hash);
        }
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "环境准备已取消"));
        }
        let bytes = serde_json::to_vec(&manifest)?;
        let mut pending = tempfile::NamedTempFile::new_in(&root)?;
        pending.write_all(&bytes)?;
        pending
            .persist(root.join("huiyu-code-integrity.json"))
            .map_err(|error| error.error)?;
        verified.manifest = hex::encode(Sha256::digest(&bytes));
        save_cache(&cache, &verified);
        let _ = send.send((total, total, "环境文件校验完成".into()));
        Ok(())
    });
    loop {
        tokio::select! {
            result = &mut work => return result.map_err(|_| invalid())?,
            Some((done, total, file)) = receive.recv() => progress(done, total, &file),
        }
    }
}
fn invalid() -> ApiError {
    ApiError::new(
        409,
        "COMFY_CODE_UNVERIFIED",
        "受管 ComfyUI 代码完整性无法确认或文件已改变，已停止启动；请在控制室重新准备环境，从已校验运行包重建，原模型与资源保留",
    )
}
fn scan(
    root: &Path,
    relative: &str,
    files: &mut BTreeMap<String, PathBuf>,
    cancel: &CancellationToken,
) -> Result<()> {
    if cancel.is_cancelled() {
        return Err(ApiError::new(499, "CANCELLED", "代码校验已取消"));
    }
    let path = root.join(relative);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| invalid())?;
    if metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(&path)? {
            let name = entry?.file_name().into_string().map_err(|_| invalid())?;
            if relative == "ComfyUI"
                && ["models", "input", "output", "temp", "user"]
                    .contains(&name.to_ascii_lowercase().as_str())
            {
                continue;
            }
            scan(root, &format!("{relative}/{name}"), files, cancel)?;
        }
    } else if metadata.is_file() {
        files.insert(relative.into(), path);
    } else {
        return Err(invalid());
    }
    Ok(())
}
pub(in crate::control) async fn verify(
    comfy: &Path,
    cancel: &CancellationToken,
    cache: &Path,
    progress: impl Fn(u64, u64, &str),
) -> Result<()> {
    let root = comfy.parent().ok_or_else(invalid)?.to_owned();
    // Baselines describe the fixed portable layout. External environments must
    // be started by their own owner and connected through the existing endpoint.
    if comfy.file_name().and_then(|name| name.to_str()) != Some("ComfyUI") {
        return Err(invalid());
    }
    if crate::control::setup_environment::managed_comfy_environment(comfy)["state"] != "verified" {
        return Err(invalid());
    }
    let cancel = cancel.clone();
    let cache = cache.to_owned();
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    progress(0, 0, "正在检查环境文件清单");
    let mut work = tokio::task::spawn_blocking(move || {
        let manifest_path = root.join("huiyu-code-integrity.json");
        let metadata = std::fs::symlink_metadata(&manifest_path).map_err(|_| invalid())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 16 * 1024 * 1024
        {
            return Err(invalid());
        }
        let manifest_bytes = std::fs::read(&manifest_path)?;
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|_| invalid())?;
        let receipt: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("huiyu-environment.json")).map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        if manifest.schema_version != 1
            || manifest.archive_sha256 != receipt["archiveSha256"].as_str().unwrap_or("")
            || manifest.files.is_empty()
            || !manifest.files.contains_key("ComfyUI/main.py")
            || !manifest.files.contains_key("python_embeded/python.exe")
        {
            return Err(invalid());
        }
        let mut files = BTreeMap::new();
        scan(&root, "ComfyUI", &mut files, &cancel)?;
        scan(&root, "python_embeded", &mut files, &cancel)?;
        if files.len() != manifest.files.len() || files.keys().ne(manifest.files.keys()) {
            return Err(invalid());
        }
        let root_key = crate::file_paths::key(&root)?;
        let manifest_key = hex::encode(Sha256::digest(&manifest_bytes));
        let previous = std::fs::symlink_metadata(&cache)
            .ok()
            .filter(|m| m.is_file() && !m.file_type().is_symlink() && m.len() < 32 * 1024 * 1024)
            .and_then(|_| std::fs::read(&cache).ok())
            .and_then(|bytes| serde_json::from_slice::<VerifiedFiles>(&bytes).ok())
            .filter(|value| value.root == root_key && value.manifest == manifest_key);
        let mut verified = VerifiedFiles {
            root: root_key,
            manifest: manifest_key,
            files: BTreeMap::new(),
        };
        let total = files.len() as u64;
        let mut reported = Instant::now() - Duration::from_secs(1);
        let mut buffer = vec![0; 1024 * 1024];
        for (index, (relative, path)) in files.into_iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(ApiError::new(499, "CANCELLED", "代码校验已取消"));
            }
            if reported.elapsed() >= Duration::from_millis(200) {
                let _ = send.send((index as u64, total, relative.clone()));
                reported = Instant::now();
            }
            let mut input = std::fs::File::open(&path)?;
            let before = stamp(&input).ok();
            // Reopen every file. Cache hits require volume/file identity and
            // ChangeTime too, so replacing a file or restoring mtime is a miss.
            if let Some(before) = before.as_ref()
                && previous
                    .as_ref()
                    .and_then(|cache| cache.files.get(&relative))
                    == Some(before)
                && stamp(&input).ok().as_ref() == Some(before)
                && std::fs::File::open(&path)
                    .and_then(|file| stamp(&file))
                    .ok()
                    .as_ref()
                    == Some(before)
            {
                verified.files.insert(relative, before.clone());
                continue;
            }
            if digest(&mut input, &mut buffer, &cancel)? != manifest.files[&relative] {
                return Err(invalid());
            }
            if let Some(before) = before {
                if stamp(&input)? != before
                    || std::fs::File::open(&path).and_then(|file| stamp(&file))? != before
                {
                    return Err(invalid());
                }
                verified.files.insert(relative, before);
            }
        }
        let _ = send.send((total, total, "环境代码校验完成".into()));
        // This acceleration record lives in the private runtime, separate from
        // downloaded code. A missing/stale record always falls back to SHA-256.
        save_cache(&cache, &verified);
        Ok(())
    });
    loop {
        tokio::select! {
            result = &mut work => return result.map_err(|_| invalid())?,
            Some((done, total, file)) = receive.recv() => progress(done, total, &file),
        }
    }
}
