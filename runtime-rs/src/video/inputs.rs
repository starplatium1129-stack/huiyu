use super::*;
use regex::Regex;
use std::{io::Read, sync::LazyLock};
const MAX_BYTES: u64 = 20 * 1024 * 1024;
static INPUT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^aics_video_input_[a-f0-9]{16,40}\.(?:png|jpg|jpeg|webp)$").unwrap()
});
static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^aics_video_ref_[a-f0-9]{16,40}\.(?:png|jpg|jpeg|webp)$").unwrap()
});
static MOTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^aics_video_motion_[a-f0-9]{40}\.mp4$").unwrap());
static AUDIO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^aics_video_audio_[a-f0-9]{40}\.wav$").unwrap());

pub(crate) fn driver_mime(name: &str) -> Option<&'static str> {
    if MOTION.is_match(name) {
        Some("video/mp4")
    } else if AUDIO.is_match(name) {
        Some("audio/wav")
    } else {
        None
    }
}
static HASHERS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(2)));
pub(super) fn valid_name(name: &str, reference: bool) -> bool {
    if reference {
        REFERENCE.is_match(name)
    } else {
        INPUT.is_match(name)
    }
}
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
#[derive(Clone)]
pub(super) struct Original {
    pub name: String,
    pub file: generation::native::InputFile,
    pub mime: String,
}
pub(super) struct Captured {
    pub originals: Vec<Original>,
}
impl Captured {
    pub fn frame(&self, name: &Value) -> Result<Option<generation::native::InputFile>> {
        name.as_str()
            .map(|name| {
                self.originals
                    .iter()
                    .find(|original| original.name == name)
                    .map(|original| original.file.clone())
                    .ok_or_else(|| error(409, "TASK_INPUT_MISSING", "找不到已接收的关键帧"))
            })
            .transpose()
    }
    pub fn subset(&self, input: &Value) -> Self {
        let names = names(input);
        Self {
            originals: self
                .originals
                .iter()
                .filter(|o| names.contains(&o.name.as_str()))
                .cloned()
                .collect(),
        }
    }
}
pub(super) fn names(input: &Value) -> Vec<&str> {
    let mut names = Vec::new();
    for key in ["image", "lastFrame", "drivingAudio", "drivingVideo"] {
        if let Some(name) = input[key].as_str() {
            names.push(name)
        }
    }
    if let Some(refs) = input["references"].as_array() {
        names.extend(refs.iter().filter_map(Value::as_str));
    }
    names.sort_unstable();
    names.dedup();
    names
}
pub(super) fn path(config: &Config, name: &str) -> Result<PathBuf> {
    if !valid_name(name, false) && !valid_name(name, true) && driver_mime(name).is_none() {
        return Err(error(400, "INVALID_PARAMETER", "图片引用格式不受支持"));
    }
    Ok(config.ai_workspace_root.join("ComfyUI/input").join(name))
}
async fn safe(config: &Config, name: &str) -> Result<PathBuf> {
    let path = path(config, name)?;
    let root = tokio::fs::canonicalize(config.ai_workspace_root.join("ComfyUI/input")).await?;
    let target = tokio::fs::canonicalize(&path).await?;
    if target == root || !target.starts_with(root) {
        return Err(error(403, "TASK_INPUT_FORBIDDEN", "输入图像超出授权目录"));
    }
    Ok(path)
}
async fn open(config: &Config, name: &str) -> Result<(tokio::fs::File, u64)> {
    let file = tokio::fs::File::open(safe(config, name).await?).await?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(error(400, "TASK_INPUT_INVALID", "输入图像不是普通文件"));
    }
    Ok((file, metadata.len()))
}
async fn read(config: &Config, name: &str) -> Result<Vec<u8>> {
    let (file, length) = open(config, name).await?;
    // Metadata only sizes the buffer; the bounded read below remains authoritative.
    // Leave room to detect EOF without growing a full image allocation.
    let mut bytes = Vec::with_capacity(length.min(MAX_BYTES) as usize + 1);
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).await?;
    if bytes.len() < 16 || bytes.len() as u64 > MAX_BYTES {
        return Err(error(
            400,
            "TASK_INPUT_INVALID",
            "输入图像大小超出 16B—20MB",
        ));
    }
    Ok(bytes)
}
async fn fingerprint_file(
    config: &Config,
    name: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let cancelled = || error(499, "CANCELLED", "输入保护已取消");
    let (file, _) = tokio::select! { biased;
        _ = scope.cancelled() => return Err(cancelled()),
        file = open(config, name) => file?,
    };
    let permit = tokio::select! { biased;
        _ = scope.cancelled() => return Err(cancelled()),
        permit = HASHERS.clone().acquire_owned() => permit.map_err(|_| cancelled())?,
    };
    let file = file.into_std().await;
    tokio::task::spawn_blocking(move || {
        // Keep admission with the actual reader, including abandoned requests.
        let _permit = permit;
        let mut file = file.take(MAX_BYTES + 1);
        let mut hash = Sha256::new();
        let mut buffer = [0; 256 * 1024];
        let mut length = 0;
        loop {
            if scope.is_cancelled() {
                return Err(cancelled());
            }
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            length += count as u64;
        }
        if length < 16 || length > MAX_BYTES {
            return Err(error(
                400,
                "TASK_INPUT_INVALID",
                "输入图像大小超出 16B—20MB",
            ));
        }
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        Ok(hex::encode(hash.finalize()))
    })
    .await
    .map_err(|_| error(503, "TASK_INPUT_UNAVAILABLE", "输入校验未完成"))?
}
pub(super) async fn size(config: &Config, name: &str) -> Result<(u32, u32)> {
    let path = safe(config, name).await?;
    let file = tokio::fs::File::open(path).await?;
    let mut header = Vec::new();
    file.take(512 * 1024).read_to_end(&mut header).await?;
    tokio::task::spawn_blocking(move || {
        image::ImageReader::new(std::io::Cursor::new(header))
            .with_guessed_format()?
            .into_dimensions()
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid image header")
            })
    })
    .await
    .map_err(|_| error(400, "INVALID_PARAMETER", "无法解析首帧图尺寸"))?
    .map_err(|_| error(400, "INVALID_PARAMETER", "无法解析首帧图尺寸"))
}
pub(super) async fn capture(
    config: &Config,
    input: &Value,
    local: bool,
    owner: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Captured> {
    let names = names(input);
    let limits = crate::images::Limits::from_environment();
    let maximum = limits.bytes.min(512 * 1024 * 1024);
    let mut total = 0u64;
    if names.len() as u64 > limits.files {
        return Err(error(413, "IMAGE_QUOTA", "任务输入超过素材文件额度"));
    }
    for name in &names {
        let path = safe(config, name).await?;
        let size = tokio::fs::metadata(path).await?.len();
        total = total.saturating_add(size);
        if total > maximum {
            return Err(error(
                413,
                "IMAGE_QUOTA",
                "任务输入快照超过 512 MiB 或配置的素材额度",
            ));
        }
    }
    let mut originals = Vec::new();
    let mut captured_bytes = 0u64;
    for name in names {
        let bytes = Arc::new(
            tokio::select! {bytes=read(config,name)=>bytes?,_=cancel.cancelled()=>return Err(error(499,"CANCELLED","输入保护已取消"))},
        );
        captured_bytes = captured_bytes.saturating_add(bytes.len() as u64);
        if captured_bytes > maximum {
            return Err(error(
                413,
                "IMAGE_QUOTA",
                "任务输入快照超过 512 MiB 或配置的素材额度",
            ));
        }
        use crate::images::ImageKind;
        let kind = match driver_mime(name) {
            Some("audio/wav") => ImageKind::DrivingAudio,
            Some("video/mp4") => ImageKind::MotionVideo,
            _ if valid_name(name, true) => ImageKind::VideoReference,
            _ => ImageKind::VideoInput,
        };
        let (mime, _) = kind.format(&bytes)
            .ok_or_else(|| error(400, "TASK_INPUT_INVALID", "输入素材格式无效"))?;
        if !local {
            let owner = owner
                .ok_or_else(|| error(403, "TASK_INPUT_FORBIDDEN", "视频素材需要所有者授权"))?;
            if !crate::images::owner_matches_for(
                &config.ai_workspace_root.join("ComfyUI/input"),
                name,
                bytes.clone(),
                owner,
                kind,
                cancel,
            )
            .await?
            {
                return Err(error(
                    403,
                    "TASK_INPUT_FORBIDDEN",
                    "视频素材不属于当前所有者",
                ));
            }
        }
        let file = generation::native::InputFile::capture(
            config.runtime_root.join("inputs/video-snapshots"),
            bytes,
            cancel,
        )
        .await?;
        originals.push(Original {
            name: name.into(),
            file,
            mime: mime.into(),
        });
    }
    Ok(Captured { originals })
}
pub(super) async fn protect_restore(
    config: &Config,
    captured: &Captured,
    hooks: Option<&dyn ExecutionHooks>,
    cancel: &CancellationToken,
) -> Result<()> {
    for original in &captured.originals {
        if cancel.is_cancelled() {
            return Err(error(499, "CANCELLED", "输入保护已取消"));
        }
        if let Some(h) = hooks {
            h.protect_input(
                original.name.clone(),
                Output::File {
                    path: original.file.path().to_owned(),
                    mime: original.mime.clone(),
                    bytes: original.file.bytes,
                },
            )
            .await?;
        }
        let target = path(config, &original.name)?;
        if !tokio::fs::try_exists(&target).await? {
            let restored = if let Some(h) = hooks {
                h.restore_input(original.name.clone(), target.clone())
                    .await?
            } else {
                false
            };
            if !restored {
                let mut source = BufReader::with_capacity(
                    256 * 1024,
                    tokio::fs::File::open(original.file.path()).await?,
                );
                // Stream through an owned handle so dropping the copy cannot
                // recreate a pending path after its cleanup guard has run.
                let (output, pending) =
                    tempfile::NamedTempFile::new_in(target.parent().unwrap())?.into_parts();
                let mut output = tokio::fs::File::from_std(output);
                let copied = tokio::select! {
                    result = tokio::io::copy_buf(&mut source, &mut output) => result?,
                    _ = cancel.cancelled() => return Err(error(499, "CANCELLED", "输入保护已取消")),
                };
                if copied != original.file.bytes {
                    return Err(error(409, "TASK_INPUT_CHANGED", "受保护输入的长度已改变"));
                }
                output.flush().await?;
                output.sync_all().await?;
                drop(output);
                if cancel.is_cancelled() {
                    return Err(error(499, "CANCELLED", "输入保护已取消"));
                }
                if let Err(e) = pending.persist_noclobber(&target)
                    && e.error.kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(e.error.into());
                }
            }
        }
        if fingerprint_file(config, &original.name, cancel).await? != original.file.hash {
            return Err(error(
                409,
                "TASK_INPUT_CHANGED",
                "输入图像与保护的原始字节不一致",
            ));
        }
    }
    Ok(())
}
