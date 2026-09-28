use super::*;
use crate::resources::manifest::Entry;
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::Path,
};
pub(super) fn entry(
    op: &Operation,
    source_root: &Path,
    tree: &Path,
    parts: &Path,
    entry: &Entry,
) -> Result<()> {
    cancelled(&op.cancel)?;
    let target = fs::child(tree, &entry.path)?;
    if fs::file_matches(&target, entry, &op.cancel)? {
        return op.event("copy-reused", json!({"path":entry.path}));
    }
    fs::space(&op.ctx.store, entry.bytes.saturating_add(65536))?;
    let source = fs::child(source_root, &entry.path)?;
    let stat = fs::safe(&source, false, false)?.unwrap();
    if !stat.is_file() || stat.len() != entry.bytes {
        return Err(Error::new(
            "CONTENT_INVALID",
            "Source size changed before copy",
        ));
    }
    let mut input = fs::open(&source, entry.bytes, false)?;
    fs::ensure(target.parent().unwrap())?;
    fs::ensure(parts)?;
    let partial = parts.join(format!("{}.part", crate::resources::digest(&entry.path)));
    fs::remove(&partial)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(&partial)?;
    fs::safe(&partial, false, false)?;
    let mut hash = Sha256::new();
    let mut bytes = vec![0; 512 * 1024];
    let mut total = 0_u64;
    loop {
        cancelled(&op.cancel)?;
        let count = input.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > entry.bytes {
            return Err(Error::new("CONTENT_INVALID", "Source grew during copy"));
        }
        hash.update(&bytes[..count]);
        fs::safe(&partial, false, false)?;
        output.write_all(&bytes[..count])?;
        op.event(
            "copy-progress",
            json!({"path":entry.path,"bytes":total,"total":entry.bytes}),
        )?;
    }
    if total != entry.bytes || hex::encode(hash.finalize()) != entry.sha256 {
        return Err(Error::new(
            "CONTENT_INVALID",
            "Copied bytes differ from approved manifest",
        ));
    }
    output.sync_all()?;
    drop(output);
    drop(input);
    if !fs::file_matches(&partial, entry, &op.cancel)? {
        return Err(Error::new("CONTENT_INVALID", "Copied readback failed"));
    }
    fs::safe(&target, true, false)?;
    fs::remove(&target)?;
    std::fs::rename(partial, &target)?;
    fs::sync(target.parent().unwrap())?;
    op.event("copied", json!({"path":entry.path}))
}
