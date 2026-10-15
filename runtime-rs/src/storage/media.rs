use super::*;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::Path,
};
pub(super) const CHUNK: usize = 1024 * 1024;
#[derive(Debug)]
pub struct Media {
    pub path: PathBuf,
    pub mime: String,
    pub total_bytes: u64,
    pub sha256: String,
}
pub(super) use crate::file_identity::Version as FileIdentity;
pub(super) fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn object_path(root: &Path, hash: &str) -> Result<PathBuf> {
    schema::safe(root, object_relative(hash)?)
}
fn object_relative(hash: &str) -> Result<String> {
    if !valid_hash(hash) {
        return Err(conflict("MEDIA_INVALID", "Invalid media digest"));
    }
    Ok(format!("media/objects/{}/{}", &hash[..2], hash))
}
pub(super) fn staging_path(root: &Path, key: &str, alias: &str) -> Result<PathBuf> {
    if !valid_hash(key) {
        return Err(conflict("MEDIA_INVALID", "Invalid operation identity"));
    }
    schema::safe(
        root,
        format!("media/staging/{}/{}", key, canonical::digest(alias)),
    )
}
pub(super) fn detected_mime(header: &[u8]) -> Option<&'static str> {
    if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if header.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    if header.get(4..8) == Some(b"ftyp") {
        if matches!(header.get(8..12), Some(b"avif" | b"avis")) {
            return Some("image/avif");
        }
        if matches!(
            header.get(8..12),
            Some(b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" | b"M4V ")
        ) {
            return Some("video/mp4");
        }
    }
    if header.starts_with(b"\x1a\x45\xdf\xa3") && header.windows(4).any(|s| s == b"webm") {
        return Some("video/webm");
    }
    None
}
pub(super) fn hash_file_checked(
    root: &Path,
    file: &Path,
    check_cancel: impl FnMut() -> Result<()>,
) -> Result<(u64, String, Option<String>)> {
    schema::safe(
        root,
        file.strip_prefix(root)
            .map_err(|_| conflict("MEDIA_INVALID", "Media path escapes workspace"))?,
    )?;
    let mut input = File::open(file)?;
    hash_opened(&mut input, check_cancel)
}
pub(super) fn hash_opened(
    input: &mut File,
    mut check_cancel: impl FnMut() -> Result<()>,
) -> Result<(u64, String, Option<String>)> {
    if !input.metadata()?.is_file() {
        return Err(conflict("MEDIA_INVALID", "Media is not a regular file"));
    }
    let mut hash = Sha256::new();
    let mut chunk = vec![0; CHUNK];
    let mut bytes = 0;
    let mut mime = None;
    loop {
        check_cancel()?;
        let count = input.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        if bytes == 0 {
            mime = detected_mime(&chunk[..count.min(4096)]).map(str::to_string);
        }
        hash.update(&chunk[..count]);
        bytes += count as u64;
    }
    Ok((bytes, hex::encode(hash.finalize()), mime))
}
pub(super) fn verify_checked(
    root: &Path,
    file: &Path,
    hash: &str,
    bytes: u64,
    mime: &str,
    check_cancel: impl FnMut() -> Result<()>,
) -> Result<()> {
    if fs::metadata(file)?.len() != bytes {
        return Err(conflict(
            "MEDIA_INVALID",
            "Media byte length does not match",
        ));
    }
    let (actual, sha, detected) = hash_file_checked(root, file, check_cancel)?;
    if actual != bytes || sha != hash || detected.as_deref() != Some(mime) {
        return Err(conflict(
            "MEDIA_INVALID",
            "Media digest or actual file type does not match",
        ));
    }
    Ok(())
}
impl Context {
    pub(super) fn lookup_media(&mut self, alias: &str) -> Result<Media> {
        self.check_cancel()?;
        let (hash,bytes,mime)=self.db.prepare_cached("SELECT m.hash,m.bytes,m.mime FROM media_aliases a JOIN media_objects m ON m.hash=a.hash WHERE a.alias=?")?.query_row([alias],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?))).optional()?.ok_or_else(||ApiError::new(404,"NOT_FOUND","Media does not exist"))?;
        let bytes = u64::try_from(bytes)
            .map_err(|_| conflict("MEDIA_INVALID", "Invalid media byte count"))?;
        // Read-only lookup stays on SQLite's worker. The bounded verifier
        // checks the directory chain immediately before opening the file.
        let path = self.root.join(object_relative(&hash)?);
        Ok(Media {
            path,
            mime,
            total_bytes: bytes,
            sha256: hash,
        })
    }
}
pub(super) fn validate(input: &Value) -> Result<()> {
    if !input["sha256"].as_str().is_some_and(valid_hash)
        || input["bytes"]
            .as_u64()
            .is_none_or(|v| v == 0 || v > 9_007_199_254_740_991)
        || input["alias"].as_str().is_none_or(str::is_empty)
        || !matches!(
            input["mime"].as_str(),
            Some(
                "image/png"
                    | "image/jpeg"
                    | "image/gif"
                    | "image/webp"
                    | "image/avif"
                    | "video/mp4"
                    | "video/webm"
            )
        )
    {
        return Err(ApiError::new(
            400,
            "MEDIA_INVALID",
            "Invalid save media metadata",
        ));
    }
    Ok(())
}
pub(super) fn uploaded(c: &Context, key: &str, media: &Value) -> Result<u64> {
    let file = staging_path(&c.root, key, string(media, "alias")?)?;
    match fs::metadata(file) {
        Ok(s) if s.is_file() => Ok(s.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.into()),
        _ => Err(conflict("MEDIA_INVALID", "Media is not a regular file")),
    }
}
pub(super) fn sync_checked(
    root: &Path,
    path: &Path,
    mut check_cancel: impl FnMut() -> Result<()>,
) -> Result<()> {
    check_cancel()?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| invalid("Media path escapes workspace"))?;
    schema::safe(root, relative)?;
    let input = OpenOptions::new().read(true).write(true).open(path)?;
    if !input.metadata()?.is_file() {
        return Err(conflict("MEDIA_INVALID", "Media is not a regular file"));
    }
    let native = crate::file_identity::opened(&input)?;
    if crate::file_identity::path(path, false)? != native {
        return Err(conflict("MEDIA_INVALID", "Media file changed before sync"));
    }
    input.sync_all()?;
    schema::safe(root, relative)?;
    if crate::file_identity::path(path, false)? != native {
        return Err(conflict("MEDIA_INVALID", "Media file changed during sync"));
    }
    check_cancel()
}
pub(super) fn cleanup(c: &Context, key: &str, media: &Value) {
    if let Ok(file) = staging_path(&c.root, key, media["alias"].as_str().unwrap_or("")) {
        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(file.parent().unwrap());
    }
}
