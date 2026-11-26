use super::{SnapshotIdentity, export_conflict, rename_export};
use crate::error::{ApiError, Result};
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

enum Operation {
    Replace,
    Remove,
}

struct FileChange<'a> {
    name: &'a str,
    operation: Operation,
    backup: Option<PathBuf>,
}

pub(super) fn sync_export_in_place(
    staging: &Path,
    directory: &Path,
    files: &[String],
    changed: &HashSet<String>,
    before: &SnapshotIdentity,
) -> Result<()> {
    let parent = directory.parent().ok_or_else(export_conflict)?;
    let backup = tempfile::Builder::new()
        .prefix(".catalog-export-rollback-")
        .tempdir_in(parent)?;
    let new_names: HashSet<_> = files.iter().map(|name| name.to_ascii_lowercase()).collect();
    let mut replacements = files
        .iter()
        .filter(|name| changed.contains(*name) || !directory.join(name).exists())
        .map(|name| (name.as_str(), Operation::Replace))
        .collect::<Vec<_>>();
    let mut removed = before
        .files
        .values()
        .map(|(original, _)| original.as_str())
        .filter(|name| !new_names.contains(&name.to_ascii_lowercase()))
        .collect::<Vec<_>>();
    removed.sort_unstable();
    replacements.extend(removed.into_iter().map(|name| (name, Operation::Remove)));
    replacements.push(("manifest.json", Operation::Replace));

    // Finish every backup before changing the first published file. Replacement
    // and restoration use same-volume renames. Publish the manifest only at the end.
    let plan = replacements
        .into_iter()
        .map(|(name, operation)| {
            let backup_file = backup.path().join(name);
            if let Some(parent) = backup_file.parent() {
                fs::create_dir_all(parent)?;
            }
            let backup = match fs::copy(directory.join(name), &backup_file) {
                Ok(_) => Some(backup_file),
                Err(error) if error.kind() == ErrorKind::NotFound => None,
                Err(error) => return Err(ApiError::from(error)),
            };
            Ok(FileChange {
                name,
                operation,
                backup,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if !before.matches(directory)? {
        return Err(export_conflict());
    }

    for (index, change) in plan.iter().enumerate() {
        if let Err(error) = apply(staging, directory, change) {
            let mut rollback_error = None;
            for applied in plan[..index].iter().rev() {
                if let Err(error) = restore(directory, applied) {
                    rollback_error.get_or_insert(error);
                }
            }
            if let Some(rollback_error) = rollback_error {
                let path = backup.keep();
                return Err(ApiError::new(
                    503,
                    "CATALOG_EXPORT_ROLLBACK",
                    format!(
                        "导出失败：{}；恢复失败：{}；备份保留在 {}",
                        error.message,
                        rollback_error.message,
                        path.display(),
                    ),
                ));
            }
            return Err(error);
        }
    }
    Ok(())
}

fn apply(staging: &Path, directory: &Path, change: &FileChange<'_>) -> Result<()> {
    let target = directory.join(change.name);
    match change.operation {
        Operation::Replace => {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            rename_export(&staging.join(change.name), &target)
        }
        Operation::Remove => {
            fs::remove_file(target)?;
            Ok(())
        }
    }
}

fn restore(directory: &Path, change: &FileChange<'_>) -> Result<()> {
    let target = directory.join(change.name);
    if let Some(backup) = &change.backup {
        return rename_export(backup, &target);
    }
    fs::remove_file(target)?;
    Ok(())
}
