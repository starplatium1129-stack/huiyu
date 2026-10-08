//! One updater-owned cache slot. No paths or filenames come from the manifest.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

pub(super) const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Record {
    pub identity: String,
    pub etag: Option<String>,
    pub resource: String,
    pub total: Option<u64>,
}

pub(super) struct Cache {
    pub file: File,
    pub record: Record,
    metadata: File,
    // OS-owned lock is released on cancellation, crash or process exit.
    _lock: File,
}

// Refuse redirected cache paths before opening/truncating files. Cache belongs to
// this OS user's application data, never the install tree or workspace assets.
fn plain_path(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(meta) => {
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
                };
                #[cfg(not(windows))]
                let linked = meta.file_type().is_symlink();
                if linked {
                    return Err("更新缓存路径包含链接，请清理该缓存目录后重试".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

// Open without truncation and validate the handle before any cache mutation.
fn owned_file(path: &Path) -> Result<File, String> {
    plain_path(path)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let links = {
        use std::os::unix::fs::MetadataExt;
        metadata.nlink()
    };
    #[cfg(windows)]
    let links = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, info.as_mut_ptr()) } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        u64::from(unsafe { info.assume_init() }.nNumberOfLinks)
    };
    #[cfg(not(any(unix, windows)))]
    let links = 0;
    if !metadata.is_file() || links != 1 {
        return Err("更新缓存必须是独立普通文件，不能与其他文件共享硬链接".into());
    }
    Ok(file)
}

impl Cache {
    pub fn open(root: &Path, identity: &str) -> Result<Self, String> {
        plain_path(root)?;
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let lock_path = root.join("download.lock");
        let metadata = root.join("download.json");
        let part = root.join("package.part");
        for path in [&lock_path, &metadata, &part] {
            plain_path(path)?;
        }
        let lock = owned_file(&lock_path)?;
        lock.try_lock()
            .map_err(|_| "另一个进程正在使用更新缓存".to_string())?;
        let file = owned_file(&part)?;
        let mut metadata = owned_file(&metadata)?;
        let record = metadata
            .metadata()
            .ok()
            .filter(|m| m.len() <= 16_384)
            .and_then(|_| {
                let mut bytes = Vec::new();
                (&mut metadata).take(16_385).read_to_end(&mut bytes).ok()?;
                serde_json::from_slice::<Record>(&bytes).ok()
            })
            .unwrap_or_default();
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        let fresh = file
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age < Duration::from_secs(7 * 86400));
        let reusable = record.identity == identity
            && fresh
            && len > 0
            && record
                .total
                .is_some_and(|total| total >= len && total <= MAX_BYTES)
            && record.etag.as_deref().is_some_and(strong_etag)
            && !record.resource.is_empty();
        let mut cache = Self {
            file,
            record,
            metadata,
            _lock: lock,
        };
        if !reusable {
            cache.reset(identity)?;
        }
        Ok(cache)
    }

    pub fn len(&self) -> Result<u64, String> {
        self.file
            .metadata()
            .map(|m| m.len())
            .map_err(|e| e.to_string())
    }

    pub fn reset(&mut self, identity: &str) -> Result<(), String> {
        // Invalidate metadata first: a crash can never attach an old prefix to a
        // new identity. A torn JSON write is deliberately treated as a cache miss.
        self.record = Record {
            identity: identity.into(),
            ..Record::default()
        };
        self.save()?;
        self.file.set_len(0).map_err(|e| e.to_string())?;
        // Persist truncation before a later response publishes a new valid record.
        // Otherwise power loss could pair new metadata with an old on-disk prefix.
        self.file.sync_all().map_err(|e| e.to_string())?;
        self.file.rewind().map_err(|e| e.to_string())
    }

    pub fn save(&mut self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.record).map_err(|e| e.to_string())?;
        self.metadata.rewind().map_err(|e| e.to_string())?;
        self.metadata.set_len(0).map_err(|e| e.to_string())?;
        self.metadata
            .write_all(&bytes)
            .and_then(|_| self.metadata.sync_all())
            .map_err(|e| e.to_string())
    }

    pub fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.file
            .seek(SeekFrom::End(0))
            .and_then(|_| self.file.write_all(bytes))
            .map_err(|e| format!("写入更新缓存失败：{e}"))
    }

    pub fn bytes(&mut self) -> Result<Vec<u8>, String> {
        self.file
            .sync_data()
            .and_then(|_| self.file.rewind())
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        self.file
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    }
}

pub(super) fn strong_etag(value: &str) -> bool {
    value.len() >= 2
        && value.starts_with('"')
        && value.ends_with('"')
        && value.as_bytes()[1..value.len() - 1]
            .iter()
            .all(|b| *b == 0x21 || *b >= 0x23 && *b != 0x7f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_metadata_handle_preserves_resume_and_locking() {
        let root = std::env::temp_dir().join(format!(
            "huiyu-updater-resume-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut cache = Cache::open(&root, "manifest").unwrap();
        assert!(Cache::open(&root, "manifest").is_err());
        cache.record.etag = Some("\"fixture\"".into());
        cache.record.resource = "fixture-resource".into();
        cache.record.total = Some(8);
        cache.save().unwrap();
        cache.append(b"prefix").unwrap();
        drop(cache);
        let mut cache = Cache::open(&root, "manifest").unwrap();
        assert_eq!(cache.record.total, Some(8));
        assert_eq!(cache.bytes().unwrap(), b"prefix");
        cache.reset("next").unwrap();
        assert_eq!(cache.len().unwrap(), 0);
        drop(cache);
        let metadata: Record =
            serde_json::from_slice(&fs::read(root.join("download.json")).unwrap()).unwrap();
        assert_eq!(metadata.identity, "next");
        assert!(metadata.total.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hardlinked_cache_files_never_modify_unrelated_bytes() {
        for name in ["package.part", "download.json"] {
            let root = std::env::temp_dir().join(format!(
                "huiyu-updater-links-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            let original = root.join("unrelated.bin");
            fs::write(&original, b"retain original bytes").unwrap();
            fs::hard_link(&original, root.join(name)).unwrap();
            let outcome = Cache::open(&root, "new-manifest");
            let original_bytes = fs::read(&original).unwrap();
            let linked_bytes = fs::read(root.join(name)).unwrap();
            assert!(outcome.is_err(), "shared {name} must be rejected");
            assert_eq!(original_bytes, b"retain original bytes");
            assert_eq!(linked_bytes, b"retain original bytes");
            drop(outcome);
            fs::remove_dir_all(root).unwrap();
        }
    }
}
