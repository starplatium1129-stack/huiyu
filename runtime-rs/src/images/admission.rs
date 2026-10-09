use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use regex::Regex;
use sha2::Sha256;
use std::{path::Path, sync::LazyLock, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, Semaphore},
};
#[cfg(test)]
mod tests;
static CAPACITY: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));
static SERIAL: Mutex<()> = Mutex::const_new(());
static OWNED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^aics_(?:video_(?:ref|input)|anima_input)_[a-f0-9]+\.(?:png|jpe?g|webp)$")
        .unwrap()
});
#[derive(Clone, Copy)]
pub struct Limits {
    pub bytes: u64,
    pub files: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            bytes: 512 * 1024 * 1024,
            files: 1024,
        }
    }
}
impl Limits {
    pub fn from_environment() -> Self {
        let defaults = Self::default();
        Self {
            bytes: std::env::var("AICS_IMAGE_STORAGE_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v| (1024..=8 * 1024 * 1024 * 1024).contains(v))
                .unwrap_or(defaults.bytes),
            files: std::env::var("AICS_IMAGE_STORAGE_FILES")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v| (1..=100000).contains(v))
                .unwrap_or(defaults.files),
        }
    }
}
#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Anima,
    VideoInput,
    VideoReference,
}
impl Kind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Anima => "aics_anima_input",
            Self::VideoInput => "aics_video_input",
            Self::VideoReference => "aics_video_ref",
        }
    }
    fn maximum(self) -> usize {
        match self {
            Self::Anima => 16 * 1024 * 1024,
            _ => 20 * 1024 * 1024,
        }
    }
}
fn name(salt: &[u8], owner: &str, bytes: &[u8], extension: &str, kind: Kind) -> String {
    let mut hmac = Hmac::<Sha256>::new_from_slice(salt).expect("HMAC accepts owner salt");
    hmac.update(owner.as_bytes());
    hmac.update(&[0]);
    hmac.update(bytes);
    format!(
        "{}_{}.{}",
        kind.prefix(),
        &hex::encode(hmac.finalize().into_bytes())[..40],
        extension
    )
}
pub(super) async fn owner_matches(
    root: &Path,
    filename: &str,
    bytes: &[u8],
    owner: &str,
) -> Result<bool> {
    owner_matches_for(root, filename, bytes, owner, Kind::Anima).await
}
pub(crate) async fn owner_matches_for(
    root: &Path,
    filename: &str,
    bytes: &[u8],
    owner: &str,
    kind: Kind,
) -> Result<bool> {
    let salt = tokio::fs::read(root.join(".aics-image-owner-salt")).await?;
    if salt.len() != 32 {
        return Err(ApiError::new(
            409,
            "IMAGE_STORAGE_INVALID",
            "素材身份文件损坏，请检查后重试。",
        ));
    }
    Ok(decode::sniff(bytes)
        .is_some_and(|(_, extension)| filename == name(&salt, owner, bytes, extension, kind)))
}
async fn owner_salt(root: &Path, cancel: &CancellationToken) -> Result<Vec<u8>> {
    let target = root.join(".aics-image-owner-salt");
    match tokio::fs::read(&target).await {
        Ok(salt) => return Ok(salt), // Existing corrupt identities remain fail-closed.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut salt = Vec::with_capacity(32);
    salt.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    salt.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    let (file, pending) = tempfile::Builder::new()
        .prefix(".aics-image-owner-salt.")
        .suffix(".pending")
        .tempfile_in(root)?
        .into_parts();
    let file = tokio::fs::File::from_std(file);
    #[cfg(test)]
    let file = tests::salt_file(file, &pending, cancel);
    let mut file = file;
    file.write_all(&salt).await?;
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    if cancel.is_cancelled() {
        return Err(inputs::cancelled());
    }
    // The existing admission lock serializes writers; no-clobber publication
    // additionally preserves any identity installed by a racing external owner.
    match pending.persist_noclobber(&target) {
        Ok(()) => Ok(salt),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(tokio::fs::read(target).await?)
        }
        Err(error) => Err(error.error.into()),
    }
}

pub(super) async fn store(
    root: PathBuf,
    image: String,
    owner: String,
    limits: Limits,
    cancel: CancellationToken,
) -> Result<String> {
    store_for(root, image, owner, limits, cancel, Kind::Anima).await
}
pub(crate) async fn store_for(
    root: PathBuf,
    image: String,
    owner: String,
    limits: Limits,
    cancel: CancellationToken,
    kind: Kind,
) -> Result<String> {
    let permit = CAPACITY
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(503, "QUEUE_FULL", "素材写入队列已满，请稍后再试"))?;
    let _serial = tokio::select! {guard=SERIAL.lock()=>guard,_=cancel.cancelled()=>return Err(inputs::cancelled())};
    if image.len() > 28 * 1024 * 1024 {
        return Err(error("INVALID_IMAGE", "图片数据超出大小限制"));
    }
    let bytes = tokio::task::spawn_blocking(move || {
        let data = if image.starts_with("data:image/") {
            image
                .split_once(";base64,")
                .map(|(_, data)| data)
                .unwrap_or(&image)
        } else {
            &image
        };
        STANDARD
            .decode(data)
            .map_err(|_| error("INVALID_IMAGE", "图片编码无效"))
    })
    .await
    .map_err(|_| error("INVALID_IMAGE", "图片解码失败"))??;
    if bytes.is_empty() || bytes.len() > kind.maximum() {
        return Err(error("INVALID_IMAGE", "图片数据超出大小限制"));
    }
    let extension = decode::sniff(&bytes)
        .ok_or_else(|| {
            error(
                "INVALID_IMAGE_FORMAT",
                "不支持的图片格式（仅限 PNG、JPEG、WebP）",
            )
        })?
        .1;
    let bytes = Arc::new(bytes);
    tokio::fs::create_dir_all(&root).await?;
    let lock = root.join(".aics-image-admission.lock");
    let mut acquired = false;
    for _ in 0..100 {
        if cancel.is_cancelled() {
            return Err(inputs::cancelled());
        }
        match tokio::fs::create_dir(&lock).await {
            Ok(()) => {
                acquired = true;
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        tokio::select! {_=tokio::time::sleep(Duration::from_millis(20))=>{},_=cancel.cancelled()=>return Err(inputs::cancelled())}
    }
    if !acquired {
        return Err(ApiError::new(
            503,
            "IMAGE_STORAGE_BUSY",
            "素材写入繁忙；若网关曾异常退出，请检查素材锁后重试。",
        ));
    }
    let pending = lock.join(format!("{}_{}.tmp", kind.prefix(), uuid::Uuid::new_v4()));
    let result=async{
        let salt = owner_salt(&root, &cancel).await?;
        if salt.len()!=32{return Err(ApiError::new(409,"IMAGE_STORAGE_INVALID","素材身份文件损坏，请检查后重试。"))}let filename=name(&salt,&owner,&bytes,extension,kind);let target=root.join(&filename);
        match tokio::fs::read(&target).await{Ok(existing)if existing.as_slice()==bytes.as_slice()=>return Ok(filename),Ok(_)=>{},Err(error)if error.kind()==std::io::ErrorKind::NotFound=>{},Err(error)=>return Err(error.into())}
        let (used_bytes, files) = usage(root.clone(), cancel.clone()).await?;
        if used_bytes.saturating_add(bytes.len()as u64)>limits.bytes||files+1>limits.files{return Err(ApiError::new(413,"IMAGE_QUOTA",format!("素材额度不足（{files}/{} 文件，{used_bytes}/{} 字节）；请先检查并整理未引用素材。",limits.files,limits.bytes)))}
        decode::validate(bytes.clone(),&cancel).await?;if cancel.is_cancelled(){return Err(inputs::cancelled())}
        let file=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&pending).await?;
        #[cfg(test)]
        let file=tests::pending_file(file,&pending,&cancel);
        let mut file=file;
        file.write_all(bytes.as_slice()).await?;
        // Tokio may still be writing in the background; finish and surface errors before publishing.
        // This is a visibility barrier, not a new crash-durability guarantee for uploaded images.
        file.flush().await?;
        drop(file);
        if cancel.is_cancelled(){return Err(inputs::cancelled())}tokio::fs::hard_link(&pending,target).await?;Ok(filename)
    }.await;
    let _ = tokio::fs::remove_file(&pending).await;
    let cleanup = tokio::fs::remove_dir(&lock).await;
    drop(permit);
    if result.is_ok() {
        cleanup?;
    }
    result
}

async fn usage(root: PathBuf, cancel: CancellationToken) -> Result<(u64, u64)> {
    #[cfg(test)]
    let scan_cancellation = tests::scan_cancellation();
    // The tracked upload keeps SERIAL and its on-disk lock while awaiting this
    // single filesystem job. Cancellation returns through the normal cleanup.
    tokio::task::spawn_blocking(move || {
        if cancel.is_cancelled() {
            return Err(inputs::cancelled());
        }
        let (mut bytes, mut files) = (0u64, 0u64);
        for entry in std::fs::read_dir(root)? {
            if cancel.is_cancelled() {
                return Err(inputs::cancelled());
            }
            let entry = entry?;
            if !OWNED.is_match(&entry.file_name().to_string_lossy()) {
                continue;
            }
            if !entry.file_type()?.is_file() {
                return Err(ApiError::new(
                    409,
                    "IMAGE_STORAGE_INVALID",
                    "素材库存在异常文件，请先检查。",
                ));
            }
            bytes = bytes.saturating_add(entry.metadata()?.len());
            files += 1;
            #[cfg(test)]
            if let Some(reads) = &scan_cancellation {
                reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                cancel.cancel();
            }
        }
        if cancel.is_cancelled() {
            return Err(inputs::cancelled());
        }
        Ok((bytes, files))
    })
    .await
    .map_err(|_| ApiError::new(503, "IMAGE_STORAGE_UNAVAILABLE", "素材额度检查未完成"))?
}
