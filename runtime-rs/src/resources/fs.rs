mod platform;
use super::{Error, Result};
use crate::file_identity;
use crate::file_paths::{absolute, key};
pub(super) use platform::{available_space, hostname, space};
use serde_json::Value;
use std::{
    borrow::Cow,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
pub(super) const MAX_JSON: u64 = 16 * 1024 * 1024;
fn within_keys(root: &str, path: &str) -> bool {
    path == root
        || path
            .strip_prefix(root.trim_end_matches(std::path::MAIN_SEPARATOR))
            .is_some_and(|tail| tail.starts_with(std::path::MAIN_SEPARATOR))
}
pub(super) fn within(root: &Path, path: &Path) -> Result<bool> {
    let root = key(root)?;
    let path = key(path)?;
    Ok(within_keys(&root, &path))
}
pub(super) fn relative(value: &str) -> Result<()> {
    if value.is_empty()
        || value
            .chars()
            .any(|c| c <= '\u{1f}' || c == '\u{7f}' || "\\:<>\"|?*".contains(c))
    {
        return Err(Error::new("UNSAFE_PATH", "Expected relative POSIX path"));
    }
    for part in value.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_lowercase();
        let reserved = ["con", "prn", "aux", "nul"].contains(&stem.as_str())
            || ["com", "lpt"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|tail| {
                    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&tail)
                })
            });
        if part.is_empty() || part == "." || part == ".." || part.ends_with(['.', ' ']) || reserved
        {
            return Err(Error::new("UNSAFE_PATH", "Windows alias or reserved path"));
        }
        let decoded: Cow<'_, [u8]> = percent_encoding::percent_decode_str(part).into();
        if decoded.as_ref() != part.as_bytes()
            && (decoded
                .iter()
                .any(|byte| *byte <= 31 || *byte == 127 || b"\\/:".contains(byte))
                || decoded.as_ref() == b"."
                || decoded.as_ref() == b"..")
        {
            return Err(Error::new("UNSAFE_PATH", "Encoded separator or traversal"));
        }
    }
    Ok(())
}
pub(super) fn child(root: &Path, relative_path: &str) -> Result<PathBuf> {
    relative(relative_path)?;
    let path = root.join(relative_path);
    let root_key = key(root)?;
    let path_key = key(&path)?;
    if root_key == path_key || !within_keys(&root_key, &path_key) {
        return Err(Error::new("UNSAFE_PATH", "Path escapes owned root"));
    }
    Ok(path)
}
pub(super) fn safe(path: &Path, missing: bool, hardlinks: bool) -> Result<Option<Metadata>> {
    let path = absolute(path)?;
    if path.to_string_lossy().starts_with("\\\\") || path.to_string_lossy().starts_with("//") {
        return Err(Error::new(
            "UNSAFE_PATH",
            "Network filesystem roots are unsupported",
        ));
    }
    let mut cursor = PathBuf::new();
    let mut parts = path.components().peekable();
    while let Some(part) = parts.next() {
        cursor.push(part.as_os_str());
        if !matches!(part, Component::Normal(_)) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&cursor) {
            Ok(metadata) => metadata,
            Err(error) if missing && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            return Err(Error::new("UNSAFE_LINK", "Symbolic link rejected"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(Error::new("UNSAFE_LINK", "Reparse point rejected"));
            }
        }
        let real = match fs::canonicalize(&cursor) {
            Ok(real) => real,
            Err(error) if missing && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        if key(&real)? != key(&cursor)? {
            return Err(Error::new("UNSAFE_LINK", "Physical path differs"));
        }
        let last = parts.peek().is_none();
        if !last && !metadata.is_dir() {
            return Err(Error::new("UNSAFE_PATH", "Non-directory ancestor"));
        }
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(Error::new(
                "UNSAFE_FILE",
                "Only regular filesystem entries accepted",
            ));
        }
        if metadata.is_file() && !hardlinks && file_identity::path(&cursor, false)?.links != 1 {
            return Err(Error::new("UNSAFE_LINK", "Hardlink rejected"));
        }
        if last {
            return Ok(Some(metadata));
        }
    }
    Ok(Some(fs::metadata(path)?))
}
pub(super) fn ensure(path: &Path) -> Result<()> {
    safe(path, true, false)?;
    fs::create_dir_all(path)?;
    if !safe(path, false, false)?.unwrap().is_dir() {
        return Err(Error::new("UNSAFE_PATH", "Expected directory"));
    }
    Ok(())
}
pub(super) fn open(path: &Path, max: u64, hardlinks: bool) -> Result<File> {
    let before = safe(path, false, hardlinks)?.unwrap();
    open_checked(path, max, hardlinks, &before)
}
pub(super) fn open_checked(
    path: &Path,
    max: u64,
    hardlinks: bool,
    before: &Metadata,
) -> Result<File> {
    if !before.is_file() || before.len() > max {
        return Err(Error::new(
            "METADATA_INVALID",
            "File type or length invalid",
        ));
    }
    let before_id = file_identity::path(path, false)?;
    let file = File::open(path)?;
    safe(path, false, hardlinks)?;
    if file_identity::opened(&file)? != before_id || file.metadata()?.len() != before.len() {
        return Err(Error::new("FILE_CHANGED", "File changed while opening"));
    }
    Ok(file)
}
pub(super) fn bytes(path: &Path, max: u64, hardlinks: bool) -> Result<Vec<u8>> {
    let file = open(path, max, hardlinks)?;
    let mut bytes = Vec::new();
    file.take(max.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(Error::new("METADATA_INVALID", "File exceeds limit"));
    }

    Ok(bytes)
}
pub(super) fn json(path: &Path, optional: bool, hardlinks: bool) -> Result<Option<Value>> {
    match bytes(path, MAX_JSON, hardlinks) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| Error::new("METADATA_INVALID", "Invalid JSON")),
        Err(error) if optional && error.code == "ENOENT" => Ok(None),
        Err(error) => Err(error),
    }
}
pub(super) fn sync(path: &Path) -> Result<()> {
    #[cfg(not(windows))]
    File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}
pub(super) fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    safe(path, true, false)?;
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("UNSAFE_PATH", "No parent directory"))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    let result = (|| {
        safe(&temp, false, false)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        safe(&temp, false, false)?;
        safe(path, true, false)?;
        fs::rename(&temp, path)?;
        sync(parent)
    })();
    // Only a successful create_new gives us cleanup ownership. The closure
    // drops the file before cleanup, including on Windows and early errors.
    if result.is_err() {
        let _ = remove(&temp);
    }
    result
}
pub(super) fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut body = crate::storage::stringify(value);
    body.push('\n');
    atomic(path, body.as_bytes())
}
pub(super) fn remove(path: &Path) -> Result<()> {
    if safe(path, true, false)?.is_some() {
        fs::remove_file(path)?;
        sync(path.parent().unwrap())?;
    }
    Ok(())
}
pub(super) fn clean_temps(directory: &Path, names: &[&str]) -> Result<()> {
    safe(directory, false, false)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if names.iter().any(|base| {
            name.strip_prefix(&format!(".{base}."))
                .and_then(|rest| rest.strip_suffix(".tmp"))
                .is_some_and(|token| uuid::Uuid::parse_str(token).is_ok())
        }) {
            remove(&entry.path())?;
        }
    }
    Ok(())
}
pub(super) fn file_matches(
    path: &Path,
    entry: &super::manifest::Entry,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<bool> {
    read_verified(path, entry, cancel, None)
}
pub(super) fn verified_bytes(
    path: &Path,
    entry: &super::manifest::Entry,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    if !read_verified(path, entry, cancel, Some(&mut bytes))? {
        return Err(Error::new("CONTENT_INVALID", "Installed bytes changed"));
    }
    Ok(bytes)
}
fn read_verified(
    path: &Path,
    entry: &super::manifest::Entry,
    cancel: &tokio_util::sync::CancellationToken,
    mut output: Option<&mut Vec<u8>>,
) -> Result<bool> {
    super::config::cancelled(cancel)?;
    let Some(stat) = safe(path, true, false)? else {
        return Ok(false);
    };
    if !stat.is_file() {
        return Err(Error::new("UNSAFE_FILE", "Expected ordinary resource file"));
    }
    if stat.len() != entry.bytes {
        return Ok(false);
    }
    let mut file = open_checked(path, entry.bytes, false, &stat)?;
    if let Some(bytes) = &mut output {
        let size = usize::try_from(entry.bytes)
            .map_err(|_| Error::new("RESOURCE_BUSY", "Resource does not fit in memory"))?;
        bytes
            .try_reserve_exact(size)
            .map_err(|_| Error::new("RESOURCE_BUSY", "Resource memory is unavailable"))?;
    }
    let mut hash = sha2::Sha256::new();
    use sha2::Digest;
    let mut buffer = vec![0; entry.bytes.saturating_add(1).min(512 * 1024) as usize];
    let mut total = 0;
    loop {
        super::config::cancelled(cancel)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > entry.bytes {
            return Ok(false);
        }
        hash.update(&buffer[..count]);
        if let Some(bytes) = &mut output {
            bytes.extend_from_slice(&buffer[..count]);
        }
    }
    super::config::cancelled(cancel)?;

    Ok(total == entry.bytes && hex::encode(hash.finalize()) == entry.sha256)
}
