use crate::error::{ApiError, Result};
use std::{fs, path::Path};

/// Publish a complete seed with one directory rename. Existing user content is
/// authoritative across restarts and upgrades; missing/corrupt content is never
/// repaired by silently replacing it with bundled defaults.
pub(super) fn prepare(app: &Path, root: &Path, packaged: bool) -> Result<()> {
    if !packaged {
        return Ok(());
    }
    if root.exists() {
        if !root.is_dir()
            || !(root.join("data/scenes/manifest.json").is_file()
                || root.join("data/catalog/manifest.json").is_file()
                || root.join("catalog.sqlite").is_file())
        {
            return Err(ApiError::new(
                503,
                "CONTENT_STORE_INVALID",
                "桌面场景内容目录不完整，请恢复备份",
            ));
        }
        return Ok(());
    }
    let parent = root
        .parent()
        .ok_or_else(|| ApiError::invalid("Invalid content root"))?;
    fs::create_dir_all(parent)?;
    let staged = parent.join(format!(".content-seed-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staged)?;
    let result = (|| -> Result<()> {
        copy_tree(&app.join("data"), &staged.join("data"))?;
        if !(staged.join("data/scenes/manifest.json").is_file()
            || staged.join("data/catalog/manifest.json").is_file())
        {
            return Err(ApiError::new(
                503,
                "CONTENT_SEED_INVALID",
                "发布包缺少场景维护源数据",
            ));
        }
        fs::rename(&staged, root)?;
        Ok(())
    })();
    // Only this invocation's uncommitted staging directory is disposable.
    if staged.exists() {
        let _ = fs::remove_dir_all(&staged);
    }
    result
}
fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(ApiError::invalid("Content seed must not contain links"));
    }
    if metadata.is_dir() {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        fs::copy(source, target)?;
        // Bundled files may be marked read-only by the installer.
        let mut permissions = fs::metadata(target)?.permissions();
        #[cfg(windows)]
        #[allow(clippy::permissions_set_readonly_false)]
        // Windows only: clears the installer read-only attribute, not ACLs.
        permissions.set_readonly(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o600);
        }
        fs::set_permissions(target, permissions)?;
        fs::OpenOptions::new()
            .write(true)
            .open(target)?
            .sync_all()?;
    } else {
        return Err(ApiError::invalid("Unsupported content seed entry"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seed_is_complete_and_preserves_edits_and_bundle_on_restart() {
        let directory = tempfile::tempdir().unwrap();
        let app = directory.path().join("app");
        let root = directory.path().join("runtime/content");
        fs::create_dir_all(app.join("data/scenes")).unwrap();
        fs::write(app.join("data/scenes/manifest.json"), b"bundled").unwrap();
        prepare(&app, &root, true).unwrap();
        assert_eq!(
            fs::read(root.join("data/scenes/manifest.json")).unwrap(),
            b"bundled"
        );
        fs::write(root.join("data/scenes/manifest.json"), b"edited").unwrap();
        prepare(&app, &root, true).unwrap();
        assert_eq!(
            fs::read(root.join("data/scenes/manifest.json")).unwrap(),
            b"edited"
        );
        assert_eq!(
            fs::read(app.join("data/scenes/manifest.json")).unwrap(),
            b"bundled"
        );
        fs::write(app.join("data/scenes/manifest.json"), b"upgrade").unwrap();
        prepare(&app, &root, true).unwrap();
        assert_eq!(
            fs::read(root.join("data/scenes/manifest.json")).unwrap(),
            b"edited"
        );
    }
    #[test]
    fn failed_seed_never_publishes_partial_content_and_source_mode_does_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let app = directory.path().join("app");
        let root = directory.path().join("runtime/content");
        fs::create_dir_all(app.join("data")).unwrap();
        prepare(&app, &root, false).unwrap();
        assert!(!root.exists());
        assert!(prepare(&app, &root, true).is_err());
        assert!(!root.exists());
        assert_eq!(fs::read_dir(root.parent().unwrap()).unwrap().count(), 0);
    }
}
