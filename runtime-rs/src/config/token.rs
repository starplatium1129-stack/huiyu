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
