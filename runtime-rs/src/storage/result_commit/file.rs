use super::*;
use crate::file_identity;
use std::io::{Cursor, Read, Seek, Write};
use std::path::Path;

pub(super) fn source(pending: &Pending) -> Result<PathBuf> {
    if let Publication::Artwork(output) = &pending.output {
        return output.source(&pending.identity.root);
    }
    let path = media::object_path(&pending.identity.root, pending.hash())?;
    if path.try_exists()? {
        return Ok(path);
    }
    media::staging_path(
        &pending.identity.root,
        pending.key(),
        string(pending.output.media(), "alias")?,
    )
}

// Only the in-process task runtime can supply this owned file or byte source. The
// admitted Pending keeps ownership, writer admission and GC protection until
// copy and the existing staged/final verification have both exited.
pub(super) fn copy(
    identity: &Identity,
    path: &Path,
    media: &Value,
    source: TaskMediaSource,
) -> Result<()> {
    identity.check_paths()?;
    if path == media::object_path(&identity.root, string(media, "sha256")?)? {
        return media::sync_checked(&identity.root, path, || identity.cancelled());
    }
    let total = media["bytes"].as_u64().unwrap();
    match source {
        TaskMediaSource::Staged(staged) => {
            identity.check_paths()?;
            staged.install(&identity.root, path)?;
            identity.check_paths()
        }
        TaskMediaSource::Bytes(bytes) => {
            if bytes.len() as u64 != total {
                return Err(conflict("MEDIA_INVALID", "Task byte length changed"));
            }
            // Borrow the owned Arc payload; no full-image copy or temporary file.
            copy_from(identity, path, total, Cursor::new(bytes.as_slice()))
        }
    }
}

fn copy_from(
    identity: &Identity,
    path: &Path,
    total: u64,
    mut source: impl Read + Seek,
) -> Result<()> {
    let relative = path
        .strip_prefix(&identity.root)
        .map_err(|_| invalid("Media path escapes workspace"))?;
    schema::safe(&identity.root, relative)?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    schema::safe(&identity.root, relative)?;
    let mut staged = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    let stat = staged.metadata()?;
    if !stat.is_file() || stat.len() > total {
        return Err(conflict("MEDIA_INVALID", "Invalid staged task file length"));
    }
    identity.check_paths()?;
    let native = file_identity::opened(&staged)?;
    if file_identity::path(path, false)? != native {
        return Err(conflict("MEDIA_INVALID", "Staged task file changed"));
    }
    let mut offset = stat.len();
    let mut buffer = vec![0; media::CHUNK];
    source.rewind()?;
    staged.rewind()?;
    // Only complete copies are durable. Compare a recovered prefix before
    // resuming; a crash-corrupted uncommitted prefix is rebuilt from the source.
    // HTTP retry chunks retain their original conflict semantics.
    if offset > 0 {
        let mut existing = vec![0; offset.min(media::CHUNK as u64) as usize];
        let mut compared = 0;
        while compared < offset {
            identity.cancelled()?;
            let count = (offset - compared).min(existing.len() as u64) as usize;
            source.read_exact(&mut buffer[..count])?;
            staged.read_exact(&mut existing[..count])?;
            if buffer[..count] != existing[..count] {
                staged.set_len(0)?;
                offset = 0;
                source.rewind()?;
                staged.rewind()?;
                break;
            }
            compared += count as u64;
        }
    }
    while offset < total {
        identity.cancelled()?;
        let count = (total - offset).min(buffer.len() as u64) as usize;
        source.read_exact(&mut buffer[..count])?;
        staged.write_all(&buffer[..count])?;
        offset += count as u64;
    }
    identity.check_paths()?;
    staged.sync_all()?;
    schema::sync_dir(path.parent().unwrap())?;
    if file_identity::opened(&staged)? != native || file_identity::path(path, false)? != native {
        return Err(conflict("MEDIA_INVALID", "Staged task file changed"));
    }
    identity.cancelled()
}
