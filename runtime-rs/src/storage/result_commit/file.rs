use super::*;
use std::io::{Cursor, Read, Seek, Write};
use std::{fs::File, path::Path};

pub(in crate::storage) struct Verified {
    pub(super) path: PathBuf,
    file: File,
    native: file_identity::Identity,
    version: media::FileIdentity,
    bytes: u64,
    hash: String,
    mime: Option<String>,
}
impl Verified {
    pub(super) fn matches(&self, path: &Path, media: &Value) -> bool {
        self.path == path
            && Some(self.bytes) == media["bytes"].as_u64()
            && Some(self.hash.as_str()) == media["sha256"].as_str()
            && self.mime.as_deref() == media["mime"].as_str()
    }
    pub(super) fn check(&self, root: &Path) -> Result<()> {
        let relative = self
            .path
            .strip_prefix(root)
            .map_err(|_| invalid("Media path escapes workspace"))?;
        schema::safe(root, relative)?;
        let current = File::open(&self.path)?;
        if file_identity::opened(&current)? != self.native
            || file_identity::opened(&self.file)? != self.native
            || media::FileIdentity::of(&current)? != self.version
            || media::FileIdentity::of(&self.file)? != self.version
        {
            return Err(conflict(
                "MEDIA_INVALID",
                "Media identity or content version changed during verification",
            ));
        }
        Ok(())
    }
}

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

pub(super) fn verify(identity: &Identity, path: &Path, media: &Value) -> Result<Verified> {
    identity.cancelled()?;
    schema::safe(
        &identity.root,
        path.strip_prefix(&identity.root)
            .map_err(|_| invalid("Media path escapes workspace"))?,
    )?;
    let mut file = File::open(path)?;
    let native = file_identity::opened(&file)?;
    let version = media::FileIdentity::of(&file)?;

    let (bytes, hash, mime) = media::hash_opened(&mut file, || identity.cancelled())?;
    if bytes != media["bytes"].as_u64().unwrap()
        || hash != string(media, "sha256")?
        || mime.as_deref() != media["mime"].as_str()
    {
        return Err(conflict(
            "MEDIA_INVALID",
            "Media digest or actual file type does not match",
        ));
    }
    let verified = Verified {
        path: path.into(),
        file,
        native,
        version,
        bytes,
        hash,
        mime,
    };
    verified.check(&identity.root)?;
    identity.cancelled()?;

    Ok(verified)
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
        return Ok(());
    }
    let total = media["bytes"].as_u64().unwrap();
    match source {
        TaskMediaSource::File(file) => {
            let stat = file.metadata()?;
            if !stat.is_file() || stat.len() != total {
                return Err(conflict("MEDIA_INVALID", "Task file length changed"));
            }
            copy_from(identity, path, total, file)
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
