//! One updater-owned cache slot. No paths or filenames come from the manifest.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
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
    metadata: PathBuf,
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
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|e| e.to_string())?;
        lock.try_lock()
            .map_err(|_| "另一个进程正在使用更新缓存".to_string())?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(part)
            .map_err(|e| e.to_string())?;
        let record = fs::metadata(&metadata)
            .ok()
            .filter(|m| m.len() <= 16_384)
            .and_then(|_| fs::read(&metadata).ok())
            .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
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

    pub fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.record).map_err(|e| e.to_string())?;
        let mut file = File::create(&self.metadata).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
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
