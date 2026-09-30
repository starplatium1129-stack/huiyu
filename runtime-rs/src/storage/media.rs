use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
pub(super) const CHUNK: usize = 1024 * 1024;
pub(super) enum Chunk<'a> {
    Encoded(&'a Value),
    Bytes { offset: u64, data: &'a [u8] },
}
#[derive(Debug)]
pub struct Media {
    pub path: PathBuf,
    pub mime: String,
    pub total_bytes: u64,
    pub sha256: String,
}
#[derive(PartialEq, Eq)]
pub(super) struct FileIdentity {
    len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
}
impl FileIdentity {
    pub(super) fn of(file: &File) -> Result<Self> {
        let stat = file.metadata()?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            len: stat.len(),
            modified: stat.modified().ok(),
            created: stat.created().ok(),
            #[cfg(unix)]
            inode: stat.ino(),
            #[cfg(unix)]
            changed: (stat.ctime(), stat.ctime_nsec()),
            #[cfg(windows)]
            changed: windows_change_time(file)?,
        })
    }
}
#[cfg(windows)]
fn windows_change_time(file: &File) -> Result<i64> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct BasicInfo {
        creation: i64,
        access: i64,
        write: i64,
        change: i64,
        attributes: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            file: *mut c_void,
            class: i32,
            information: *mut c_void,
            size: u32,
        ) -> i32;
    }
    let mut info = BasicInfo::default();
    // Node's ctimeNs corresponds to ChangeTime, not CreationTime. Retain that
    // invalidation signal if an external writer restores the original mtime.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            0,
            (&mut info as *mut BasicInfo).cast(),
            std::mem::size_of::<BasicInfo>() as u32,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(info.change)
}
pub(super) fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn object_path(root: &Path, hash: &str) -> Result<PathBuf> {
    if !valid_hash(hash) {
        return Err(conflict("MEDIA_INVALID", "Invalid media digest"));
    }
    schema::safe(root, format!("media/objects/{}/{}", &hash[..2], hash))
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
pub(super) fn verify(c: &Context, file: &Path, hash: &str, bytes: u64, mime: &str) -> Result<()> {
    verify_checked(&c.root, file, hash, bytes, mime, || c.check_cancel())
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
    // Mutation paths still verify synchronously before publishing references.
    // Read-only callers use Storage::media and its bounded verifier instead.
    pub(super) fn resolve_media(&mut self, alias: &str) -> Result<Media> {
        let source = self.lookup_media(alias)?;
        verify(
            self,
            &source.path,
            &source.sha256,
            source.total_bytes,
            &source.mime,
        )?;
        Ok(source)
    }
    pub(super) fn lookup_media(&mut self, alias: &str) -> Result<Media> {
        self.check_cancel()?;
        let (hash,bytes,mime)=self.db.prepare_cached("SELECT m.hash,m.bytes,m.mime FROM media_aliases a JOIN media_objects m ON m.hash=a.hash WHERE a.alias=?")?.query_row([alias],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?))).optional()?.ok_or_else(||ApiError::new(404,"NOT_FOUND","Media does not exist"))?;
        let bytes = u64::try_from(bytes)
            .map_err(|_| conflict("MEDIA_INVALID", "Invalid media byte count"))?;
        let path = object_path(&self.root, &hash)?;
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
pub(super) fn upload(
    c: &Context,
    key: &str,
    media: &Value,
    command: &Value,
    committed: bool,
) -> Result<u64> {
    upload_chunk(c, key, media, Chunk::Encoded(command), committed)
}
pub(super) fn upload_chunk(
    c: &Context,
    key: &str,
    media: &Value,
    chunk: Chunk<'_>,
    committed: bool,
) -> Result<u64> {
    let (offset, bytes) = match chunk {
        Chunk::Encoded(command) => {
            let encoded = string(command, "data")?;
            if encoded.len() > CHUNK.div_ceil(3) * 4 {
                return Err(conflict("MEDIA_INVALID", "Invalid media chunk"));
            }
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| conflict("MEDIA_INVALID", "Invalid media chunk encoding"))?;
            let offset = command["offset"]
                .as_u64()
                .ok_or_else(|| conflict("MEDIA_INVALID", "Invalid media chunk"))?;
            (offset, Cow::Owned(bytes))
        }
        Chunk::Bytes { offset, data } => (offset, Cow::Borrowed(data)),
    };
    let total = media["bytes"].as_u64().unwrap();
    if bytes.is_empty()
        || bytes.len() > CHUNK
        || offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|v| v > total)
    {
        return Err(conflict("MEDIA_INVALID", "Invalid media chunk"));
    }
    let file = if committed {
        object_path(&c.root, string(media, "sha256")?)?
    } else {
        staging_path(&c.root, key, string(media, "alias")?)?
    };
    if !committed {
        fs::create_dir_all(file.parent().unwrap())?;
    }
    let mut input = if committed {
        OpenOptions::new().read(true).open(&file)?
    } else {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&file)?
    };
    let stat = input.metadata()?;
    if !stat.is_file() {
        return Err(conflict("MEDIA_INVALID", "Media is not a regular file"));
    }
    let length = stat.len();
    if committed || offset < length {
        if offset + bytes.len() as u64 > length {
            return Err(conflict(
                "OPERATION_CONFLICT",
                "Chunk overlaps an incomplete boundary",
            ));
        }
        let mut existing = vec![0; bytes.len()];
        input.seek(SeekFrom::Start(offset))?;
        input.read_exact(&mut existing)?;
        if bytes.as_ref() != existing {
            return Err(conflict(
                "OPERATION_CONFLICT",
                "Retried chunk differs from stored bytes",
            ));
        }
        return Ok(length);
    }
    if offset != length {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Chunk offset does not match uploaded length",
        ));
    }
    c.check_cancel()?;
    input.seek(SeekFrom::Start(offset))?;
    input.write_all(&bytes)?;
    input.sync_all()?;
    Ok(offset + bytes.len() as u64)
}
pub(super) fn publish(c: &Context, key: &str, media: &Value) -> Result<()> {
    let hash = string(media, "sha256")?;
    let bytes = media["bytes"].as_u64().unwrap();
    let mime = string(media, "mime")?;
    let destination = object_path(&c.root, hash)?;
    if destination.exists() {
        return verify(c, &destination, hash, bytes, mime);
    }
    let staged = staging_path(&c.root, key, string(media, "alias")?)?;
    verify(c, &staged, hash, bytes, mime)?;
    fs::create_dir_all(destination.parent().unwrap())?;
    c.check_cancel()?;
    match fs::hard_link(&staged, &destination) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            verify(c, &destination, hash, bytes, mime)?
        }
        Err(e) => return Err(e.into()),
    }
    schema::sync_dir(destination.parent().unwrap())
}
pub(super) fn cleanup(c: &Context, key: &str, media: &Value) {
    if let Ok(file) = staging_path(&c.root, key, media["alias"].as_str().unwrap_or("")) {
        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(file.parent().unwrap());
    }
}
