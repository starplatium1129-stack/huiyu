use super::*;
use crate::file_identity;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
};

pub(in crate::storage) struct Written {
    path: PathBuf,
    file: File,
    native: file_identity::Identity,
    version: media::FileIdentity,
    pub offset: u64,
    pub record: Option<Value>,
}
impl Written {
    pub fn check(&self, identity: &Identity) -> Result<()> {
        identity.check_paths()?;
        schema::safe(
            &identity.root,
            self.path
                .strip_prefix(&identity.root)
                .map_err(|_| invalid("Media path escapes workspace"))?,
        )?;
        if file_identity::opened(&self.file)? != self.native
            || file_identity::path(&self.path, false)? != self.native
            || media::FileIdentity::of(&self.file)? != self.version
            || media::FileIdentity::of(&File::open(&self.path)?)? != self.version
        {
            return Err(conflict("MEDIA_INVALID", "Media chunk file changed"));
        }
        Ok(())
    }
}
pub(super) fn write(
    identity: &Identity,
    chunk: &Chunk,
    offset: Option<u64>,
    data: Data,
) -> Result<Written> {
    let (key, media, committed, record) = (&chunk.key, &chunk.media, chunk.committed, chunk.record);
    identity.check_paths()?;
    let bytes = match data {
        Data::Binary(bytes) => bytes,
        Data::Encoded(encoded) => {
            if encoded.len() > media::CHUNK.div_ceil(3) * 4 {
                return Err(conflict("MEDIA_INVALID", "Invalid media chunk"));
            }
            Bytes::from(
                STANDARD.decode(encoded)
                    .map_err(|_| conflict("MEDIA_INVALID", "Invalid media chunk encoding"))?,
            )
        }
    };
    let offset = offset.ok_or_else(|| conflict("MEDIA_INVALID", "Invalid media chunk"))?;
    let total = media["bytes"].as_u64().unwrap();
    if bytes.is_empty()
        || bytes.len() > media::CHUNK
        || offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|value| value > total)
    {
        return Err(conflict("MEDIA_INVALID", "Invalid media chunk"));
    }
    let path = if committed {
        media::object_path(&identity.root, string(media, "sha256")?)?
    } else {
        media::staging_path(&identity.root, key, string(media, "alias")?)?
    };
    if !committed {
        fs::create_dir_all(path.parent().unwrap())?;
    }
    identity.check_paths()?;
    schema::safe(&identity.root, path.strip_prefix(&identity.root).unwrap())?;
    let mut input = if committed {
        OpenOptions::new().read(true).open(&path)?
    } else {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?
    };
    if !input.metadata()?.is_file() {
        return Err(conflict("MEDIA_INVALID", "Media is not a regular file"));
    }
    let native = file_identity::opened(&input)?;
    if file_identity::path(&path, false)? != native {
        return Err(conflict("MEDIA_INVALID", "Media chunk file changed"));
    }
    let length = input.metadata()?.len();
    let written = if committed || offset < length {
        if offset + bytes.len() as u64 > length {
            return Err(conflict(
                "OPERATION_CONFLICT",
                "Chunk overlaps an incomplete boundary",
            ));
        }
        let mut existing = vec![0; bytes.len()];
        input.seek(SeekFrom::Start(offset))?;
        input.read_exact(&mut existing)?;
        if bytes.as_ref() != existing.as_slice() {
            return Err(conflict(
                "OPERATION_CONFLICT",
                "Retried chunk differs from stored bytes",
            ));
        }
        length
    } else {
        if offset != length {
            return Err(conflict(
                "OPERATION_CONFLICT",
                "Chunk offset does not match uploaded length",
            ));
        }
        identity.check_paths()?;
        input.seek(SeekFrom::Start(offset))?;
        input.write_all(&bytes)?;
        offset + bytes.len() as u64
    };
    // A retry may follow a failed sync after a complete write. Matching bytes
    // alone cannot acknowledge durability; retry the sync for staging files.
    if !committed {
        input.sync_all()?;
    }
    let version = media::FileIdentity::of(&input)?;
    let decoded = if record && written == total {
        input.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        input.read_to_end(&mut bytes)?;
        Some(serde_json::from_slice(&bytes)?)
    } else {
        None
    };
    let result = Written {
        path,
        file: input,
        native,
        version,
        offset: written,
        record: decoded,
    };
    result.check(identity)?;
    Ok(result)
}
