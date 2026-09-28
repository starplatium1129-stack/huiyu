use super::{
    catalog,
    manifest::{invalid, model_file, no_links, relative},
    profile,
};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

pub(super) struct EditorLock {
    path: PathBuf,
    file: Option<File>,
}
impl EditorLock {
    pub fn acquire(root: &Path) -> Result<Self> {
        no_links(root)?;
        fs::create_dir_all(root)?;
        let path = root.join(".editor-lock");
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    ApiError::new(
                        409,
                        "LIVE2D_BUSY",
                        "Import editor busy; retry after the other operation completes",
                    )
                } else {
                    error.into()
                }
            })?;
        Ok(Self {
            path,
            file: Some(file),
        })
    }
}
impl Drop for EditorLock {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}
pub(super) fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(ApiError::new(
            499,
            "CANCELLED",
            "Live2D operation cancelled",
        ))
    } else {
        Ok(())
    }
}
pub(super) fn hash_file(path: &Path, cancel: &CancellationToken) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        check_cancel(cancel)?;
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        hasher.update(&chunk[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}
fn walk(
    directory: &Path,
    prefix: &str,
    files: &mut Vec<String>,
    cancel: &CancellationToken,
) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        check_cancel(cancel)?;
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(invalid("Imported assets cannot be links"));
        }
        let name = format!(
            "{prefix}{}",
            entry
                .file_name()
                .to_str()
                .ok_or_else(|| invalid("Invalid UTF-8 model path"))?
        );
        if kind.is_dir() {
            walk(&entry.path(), &format!("{name}/"), files, cancel)?;
        } else if name != "companion.json" {
            relative(&name)?;
            files.push(name);
        }
    }
    Ok(())
}
fn current(
    root: &Path,
    id: &str,
    cancel: &CancellationToken,
) -> Result<(PathBuf, Value, String, String)> {
    let (directory, receipt, bytes) = catalog::receipt(root, id)?;
    let revision = hex::encode(Sha256::digest(bytes));
    let mut files = Vec::new();
    walk(&directory, "", &mut files, cancel)?;
    files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let hashes = files
        .iter()
        .map(|path| {
            Ok(json!([
                path,
                hash_file(&model_file(&directory, path)?, cancel)?
            ]))
        })
        .collect::<Result<Vec<_>>>()?;
    for file in receipt["files"].as_array().unwrap() {
        model_file(
            &directory,
            relative(
                file.as_str()
                    .ok_or_else(|| invalid("Invalid receipt file"))?,
            )?,
        )?;
    }
    let manifest = receipt["manifest"].as_str().unwrap();
    model_file(&directory, relative(manifest)?)?;
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&json!([
        receipt.get("entryPath").unwrap_or(&receipt["manifest"]),
        manifest,
        hashes
    ]))?));
    Ok((directory, receipt, revision, fingerprint))
}
pub(super) fn get(root: &Path, id: &str, cancel: &CancellationToken) -> Result<Value> {
    let (_, receipt, revision, fingerprint) = current(root, id, cancel)?;
    Ok(
        json!({"id":id,"profile":receipt["profile"],"revision":revision,"fingerprint":fingerprint,"disabled":receipt["disabled"]==true,"canRollback":!receipt["previousProfile"].is_null()}),
    )
}
pub(super) fn save_receipt(directory: &Path, receipt: &Value) -> Result<String> {
    let temporary = directory.join(format!(".receipt-{}.tmp", uuid::Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(receipt)?;
    bytes.push(b'\n');
    let write = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, directory.join("companion.json"))?;
        #[cfg(not(windows))]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(temporary);
    }
    write.map(|_| hex::encode(Sha256::digest(bytes)))
}
pub(super) fn edit(
    root: &Path,
    id: &str,
    input: &Value,
    action: &str,
    cancel: &CancellationToken,
) -> Result<Value> {
    let _lock = EditorLock::acquire(root)?;
    let (directory, mut receipt, revision, fingerprint) = current(root, id, cancel)?;
    if input["revision"] != revision || input["fingerprint"] != fingerprint {
        return Err(ApiError::new(
            409,
            "LIVE2D_CHANGED",
            "Model or profile changed; reload before saving",
        ));
    }
    if action == "disable" {
        receipt["disabled"] = json!(true);
    } else {
        let next = profile::validate(
            if action == "rollback" {
                &receipt["previousProfile"]
            } else {
                &input["profile"]
            },
            action == "rollback",
        )?;
        if next["profileId"] != receipt["profile"]["profileId"]
            || next["avatarId"] != receipt["avatar"]["id"]
        {
            return Err(invalid("Profile identity cannot change"));
        }
        receipt["previousProfile"] = receipt["profile"].clone();
        receipt["profile"] = next;
    }
    check_cancel(cancel)?;
    let revision = save_receipt(&directory, &receipt)?;
    // The editor changed only companion.json, which is excluded from the asset
    // fingerprint. Reuse that snapshot instead of hashing every atlas twice.
    Ok(
        json!({"id":id,"profile":receipt["profile"],"revision":revision,"fingerprint":fingerprint,"disabled":receipt["disabled"]==true,"canRollback":!receipt["previousProfile"].is_null()}),
    )
}
