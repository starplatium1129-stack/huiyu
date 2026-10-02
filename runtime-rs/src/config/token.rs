use crate::error::Result;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

pub(super) fn load(runtime: &Path, provided: Option<&str>) -> Result<String> {
    if let Some(token) = provided.filter(|v| !v.is_empty()) {
        return Ok(token.into());
    }
    let directory = runtime.join("state");
    let target = directory.join("gateway_token");
    if let Ok(token) = std::fs::read_to_string(&target) {
        let token = token.trim();
        if token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(token.into());
        }
    }
    let mut hash = Sha256::new();
    for _ in 0..3 {
        hash.update(uuid::Uuid::new_v4().as_bytes());
    }
    let token = hex::encode(hash.finalize());
    std::fs::create_dir_all(&directory)?;
    let temporary = directory.join(format!("gateway_token.{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        writeln!(file, "{token}")?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_persisted_repaired_and_explicit_override_does_not_replace_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        assert_eq!(
            load(&root, Some("explicit-fixture-token")).unwrap(),
            "explicit-fixture-token"
        );
        assert!(!root.exists());
        let generated = load(&root, None).unwrap();
        assert_eq!(generated.len(), 64);
        assert!(generated.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(load(&root, None).unwrap(), generated);
        let file = root.join("state/gateway_token");
        let before = std::fs::read(&file).unwrap();
        assert_eq!(
            load(&root, Some("another-explicit-token")).unwrap(),
            "another-explicit-token"
        );
        assert_eq!(std::fs::read(&file).unwrap(), before);
        for corrupt in ["", "bad-token", &"z".repeat(64), &"a".repeat(63)] {
            std::fs::write(&file, corrupt).unwrap();
            let repaired = load(&root, None).unwrap();
            assert_eq!(repaired.len(), 64);
            assert!(repaired.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_eq!(load(&root, Some("")).unwrap(), repaired);
            assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), repaired);
        }
        assert_eq!(std::fs::read_dir(root.join("state")).unwrap().count(), 1);
    }
}
