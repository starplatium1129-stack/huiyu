//! Only preparation from verified packages can establish a managed code baseline.
use crate::error::{ApiError, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read, path::{Path, PathBuf}};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u8,
    archive_sha256: String,
    files: BTreeMap<String, String>,
}
fn invalid() -> ApiError {
    ApiError::new(409, "COMFY_CODE_UNVERIFIED", "受管 ComfyUI 代码完整性无法确认或文件已改变，已停止启动；请在控制室重新准备环境，从已校验运行包重建，原模型与资源保留")
}
fn scan(root: &Path, relative: &str, files: &mut BTreeMap<String, PathBuf>, cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() { return Err(ApiError::new(499, "CANCELLED", "代码校验已取消")); }
    let path = root.join(relative);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| invalid())?;
    if metadata.file_type().is_symlink() { return Err(invalid()); }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err(invalid()); }
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(&path)? {
            let name = entry?.file_name().into_string().map_err(|_| invalid())?;
            if relative == "ComfyUI" && ["models", "input", "output", "temp", "user"].contains(&name.to_ascii_lowercase().as_str()) { continue; }
            scan(root, &format!("{relative}/{name}"), files, cancel)?;
        }
    } else if metadata.is_file() {
        files.insert(relative.into(), path);
    } else { return Err(invalid()); }
    Ok(())
}
pub(in crate::control) async fn verify(comfy: &Path, cancel: &CancellationToken) -> Result<()> {
    let root = comfy.parent().ok_or_else(invalid)?.to_owned();
    // Baselines describe the fixed portable layout. External environments must
    // be started by their own owner and connected through the existing endpoint.
    if comfy.file_name().and_then(|name| name.to_str()) != Some("ComfyUI") { return Err(invalid()); }
    if crate::control::setup_environment::managed_comfy_environment(comfy)["state"] != "verified" { return Err(invalid()); }
    let cancel = cancel.clone();
    tokio::task::spawn_blocking(move || {
        let manifest_path = root.join("huiyu-code-integrity.json");
        let metadata = std::fs::symlink_metadata(&manifest_path).map_err(|_| invalid())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16 * 1024 * 1024 { return Err(invalid()); }
        let manifest: Manifest = serde_json::from_slice(&std::fs::read(&manifest_path)?).map_err(|_| invalid())?;
        let receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("huiyu-environment.json")).map_err(|_| invalid())?).map_err(|_| invalid())?;
        if manifest.schema_version != 1 || manifest.archive_sha256 != receipt["archiveSha256"].as_str().unwrap_or("")
            || manifest.files.is_empty() || !manifest.files.contains_key("ComfyUI/main.py") || !manifest.files.contains_key("python_embeded/python.exe")
        { return Err(invalid()); }
        let mut files = BTreeMap::new();
        scan(&root, "ComfyUI", &mut files, &cancel)?;
        scan(&root, "python_embeded", &mut files, &cancel)?;
        if files.len() != manifest.files.len() || files.keys().ne(manifest.files.keys()) { return Err(invalid()); }
        let mut buffer = vec![0; 1024 * 1024];
        for (relative, path) in files {
            let mut input = std::fs::File::open(path)?;
            let mut hash = Sha256::new();
            loop {
                if cancel.is_cancelled() { return Err(ApiError::new(499, "CANCELLED", "代码校验已取消")); }
                let bytes = input.read(&mut buffer)?;
                if bytes == 0 { break; }
                hash.update(&buffer[..bytes]);
            }
            if hex::encode(hash.finalize()) != manifest.files[&relative] { return Err(invalid()); }
        }
        Ok(())
    }).await.map_err(|_| invalid())?
}
