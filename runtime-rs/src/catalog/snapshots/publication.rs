#[cfg(windows)]
mod windows_rollback;

use super::{Scope, SnapshotIdentity, read_snapshot, snapshot_name};
use crate::{
    catalog::{Catalog, Record, provenance},
    error::{ApiError, Result},
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

#[derive(Serialize)]
struct ExportManifest<'a> {
    version: u8,
    files: &'a [String],
    retired: &'a [Record],
}
fn write_export(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut file = BufWriter::new(std::fs::File::create(path)?);
    serde_json::to_writer_pretty(&mut file, value).map_err(|error| {
        if error.is_io() {
            ApiError::from(std::io::Error::from(error))
        } else {
            ApiError::from(error)
        }
    })?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}
fn export_io_error(from: &Path, to: &Path, error: std::io::Error) -> ApiError {
    ApiError::new(
        503,
        "CATALOG_EXPORT_IO",
        format!(
            "快照目录切换失败 {} → {}：{error}",
            from.display(),
            to.display()
        ),
    )
}
fn rename_export_raw(from: &Path, to: &Path) -> std::io::Result<()> {
    const RETRY_DELAYS_MS: [u64; 6] = [50, 100, 200, 300, 400, 500];
    for delay_ms in RETRY_DELAYS_MS {
        match std::fs::rename(from, to) {
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            }
            result => return result,
        }
    }
    std::fs::rename(from, to)
}
fn rename_export(from: &Path, to: &Path) -> Result<()> {
    rename_export_raw(from, to).map_err(|error| export_io_error(from, to, error))
}
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        // Only our UUID staging directory is removed, never the published target or backup.
        if self.0.exists() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
fn export_conflict() -> ApiError {
    ApiError::new(
        409,
        "CATALOG_EXPORT_CONFLICT",
        "目标快照在导出期间改变，未覆盖目标；请重新读取后导出",
    )
}

impl Catalog {
    pub(in crate::catalog) fn export_selected(&self, directory: &Path, scope: &Scope) -> Result<Value> {
        if directory.exists() && !directory.join("manifest.json").exists() {
            return Err(ApiError::invalid("导出目录已被其他内容占用"));
        }
        let parent = directory
            .parent()
            .ok_or_else(|| ApiError::invalid("导出路径无效"))?;
        std::fs::create_dir_all(parent)?;
        let _export_lock = crate::file_lock::try_lock(&parent.join(".catalog-export.lock"))
            .map_err(|error| {
                ApiError::new(
                    409,
                    "CATALOG_EXPORT_BUSY",
                    format!("此目录正在导出或不可写；请等待当前导出完成后重试：{error}"),
                )
            })?;
        if directory.exists() && !scope.partial() {
            return Err(ApiError::new(
                409,
                "CATALOG_EXPORT_SCOPE_REQUIRED",
                "更新已有快照必须使用 --record 或 --character 指定范围；全库备份请导出到新的目录，不能整库覆盖项目",
            ));
        }
        let source_snapshot = self.connection.unchecked_transaction()?;
        let version = self.version()?;
        let staging = parent.join(format!(".catalog-export-{}", uuid::Uuid::new_v4()));
        let (mut records, mut retired) = self.snapshot_records(scope)?;
        let count = records.len();
        let mut original_fingerprint = None;
        let mut changed = std::collections::HashSet::new();
        if scope.partial() && directory.exists() {
            // Merge only the selected records into the project's existing export,
            // never copy unrelated personal database records over that snapshot.
            let mut identity = SnapshotIdentity::default();
            let (previous, previous_retired) = read_snapshot(directory, Some(&mut identity))?;
            original_fingerprint = Some(identity);
            let mut merged = std::collections::BTreeMap::new();
            for (record, removed) in previous
                .into_iter()
                .map(|r| (r, false))
                .chain(previous_retired.into_iter().map(|r| (r, true)))
            {
                merged.insert((record.kind.clone(), record.id.clone()), (record, removed));
            }
            for (mut record, removed) in records
                .into_iter()
                .map(|r| (r, false))
                .chain(retired.into_iter().map(|r| (r, true)))
            {
                let key = (record.kind.clone(), record.id.clone());
                if let Some((before, was_removed)) = merged.get(&key) {
                    provenance::export_ancestor(
                        &self.connection,
                        before,
                        *was_removed,
                        &record,
                        removed,
                    )?;
                    // An unknown creation date may be backfilled independently of content.
                    // Keep the project's established creation date on later content edits.
                    if before.created_at.is_some() {
                        record.created_at.clone_from(&before.created_at);
                    }
                    if provenance::same(before, &record)
                        && *was_removed == removed
                        && before.created_at == record.created_at
                    {
                        continue;
                    }
                    // The project revision is an upstream publication counter.
                    // A local database imported from it can have a lower edit
                    // counter; ancestry is proved above by content, not numbers.
                    record.revision = record.revision.max(
                        before
                            .revision
                            .checked_add(1)
                            .ok_or_else(|| ApiError::invalid("项目快照修订已用尽"))?,
                    );
                }
                if !removed {
                    let project_policy = parent.join("prompt-pinned-scenes.json");
                    let source_policy = self.options.source.join("data/prompt-pinned-scenes.json");
                    provenance::export_pins(
                        &record,
                        if project_policy.is_file() {
                            &project_policy
                        } else {
                            &source_policy
                        },
                    )?;
                }
                changed.insert(snapshot_name(&record.kind, &record.id));
                merged.insert(key, (record, removed));
            }
            records = Vec::new();
            retired = Vec::new();
            for (record, removed) in merged.into_values() {
                if removed {
                    retired.push(record);
                } else {
                    records.push(record);
                }
            }
        }
        source_snapshot.commit()?;
        std::fs::create_dir(&staging)?;
        let _staging_cleanup = Staging(staging.clone());
        let mut files = Vec::new();
        for record in records {
            let name = snapshot_name(&record.kind, &record.id);
            std::fs::create_dir_all(staging.join(&record.kind))?;
            if !changed.contains(&name)
                && let Some((original, expected)) = original_fingerprint
                    .as_ref()
                    .and_then(|source| source.files.get(&name))
            {
                let source = directory.join(original);
                let bytes = std::fs::read(&source)?;
                if <[u8; 32]>::from(Sha256::digest(&bytes)) != *expected {
                    return Err(export_conflict());
                }
                let destination = staging.join(&name);
                std::fs::write(&destination, bytes)?;
                std::fs::set_permissions(destination, source.metadata()?.permissions())?;
            } else {
                write_export(&staging.join(&name), &record)?;
            }
            files.push(name);
        }
        files.sort();
        let manifest = ExportManifest {
            version: 1,
            files: &files,
            retired: &retired,
        };
        write_export(&staging.join("manifest.json"), &manifest)?;
        if let Some(before) = original_fingerprint.as_ref() {
            if !directory.exists() || !before.matches(directory)? {
                return Err(export_conflict());
            }
        } else if directory.exists() {
            return Err(ApiError::new(
                409,
                "CATALOG_EXPORT_CONFLICT",
                "导出目标已由其他操作创建，未覆盖目标；请重新选择目录",
            ));
        }
        let backup = parent.join(format!(".catalog-export-backup-{}", uuid::Uuid::new_v4()));
        let mut fallback_in_place = false;
        if directory.exists() {
            match rename_export_raw(directory, &backup) {
                Ok(()) => {}
                #[cfg(windows)]
                Err(error)
                    if error.kind() == std::io::ErrorKind::PermissionDenied
                        && original_fingerprint.is_some() =>
                {
                    windows_rollback::sync_export_in_place(
                        &staging,
                        directory,
                        &files,
                        &changed,
                        original_fingerprint.as_ref().unwrap(),
                    )?;
                    fallback_in_place = true;
                }
                Err(error) => return Err(export_io_error(directory, &backup, error)),
            }
        }
        if !fallback_in_place && let Err(error) = rename_export(&staging, directory) {
            if backup.exists() {
                rename_export(&backup, directory)?;
            }
            return Err(error.into());
        }
        let cleanup_warning = if !fallback_in_place && backup.exists() {
            std::fs::remove_dir_all(&backup).err().map(|error| {
                format!(
                    "快照已导出，旧目录清理失败，备份保留于 {}：{error}",
                    backup.display()
                )
            })
        } else {
            None
        };
        Ok(
            json!({"ok":true,"count":count,"total":files.len(),"partial":scope.partial(),"directory":directory,"version":version,"cleanupWarning":cleanup_warning}),
        )
    }
}
