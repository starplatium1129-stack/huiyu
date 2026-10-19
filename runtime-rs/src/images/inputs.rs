use super::*;
use regex::Regex;
use std::sync::LazyLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const MAX_BYTES: usize = 16 * 1024 * 1024;
static NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^aics_anima_input_[a-f0-9]{16,40}\.(?:png|jpg|jpeg|webp)$").unwrap()
});
#[derive(Clone)]
pub(super) struct Original {
    pub name: String,
    native: bool,
    pub bytes: Arc<Vec<u8>>,
    pub mime: String,
}
pub(super) fn cancelled() -> ApiError {
    ApiError::new(499, "CANCELLED", "图像操作已取消")
}
pub(super) fn input_names(input: &Value) -> Vec<&str> {
    let mut names: Vec<&str> = ["initImage", "maskImage", "penLines"].iter()
        .filter_map(|key| input[*key].as_str()).collect();
    if let Some(name) = input["sketchControl"]["image"].as_str() { names.push(name); }
    names.sort_unstable();
    names.dedup();
    names
}
pub(super) fn root(config: &Config, native: bool) -> PathBuf {
    config.ai_workspace_root.join(if native {
        "inference/input"
    } else {
        "ComfyUI/input"
    })
}
pub(super) fn path(config: &Config, name: &str) -> Result<PathBuf> {
    path_for(config, name, false)
}
pub(super) fn path_for(config: &Config, name: &str, native: bool) -> Result<PathBuf> {
    if !NAME.is_match(name) {
        return Err(error("TASK_INPUT_INVALID", "输入图像文件名无效"));
    }
    Ok(root(config, native).join(name))
}
async fn open(config: &Config, name: &str, native: bool) -> Result<(tokio::fs::File, u64)> {
    let file = path_for(config, name, native)?;
    let root = tokio::fs::canonicalize(root(config, native)).await?;
    let target = tokio::fs::canonicalize(&file).await?;
    if !target.starts_with(&root) || target == root {
        return Err(error("TASK_INPUT_INVALID", "输入图像超出授权目录"));
    }
    let file = tokio::fs::File::open(file).await?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(error("TASK_INPUT_INVALID", "输入图像不是普通文件"));
    }
    Ok((file, metadata.len()))
}
async fn read(config: &Config, name: &str, native: bool) -> Result<Vec<u8>> {
    let (file, length) = open(config, name, native).await?;
    // Metadata only sizes the buffer; the bounded read below remains authoritative.
    // Leave room to detect EOF without growing a full image allocation.
    let mut bytes = Vec::with_capacity(length.min(MAX_BYTES as u64) as usize + 1);
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(error("TASK_INPUT_INVALID", "输入图像超过 16 MiB"));
    }
    Ok(bytes)
}
async fn matches_original(
    config: &Config,
    original: &Original,
    cancel: &CancellationToken,
) -> Result<bool> {
    let (file, _) = tokio::select! { biased;
        _ = cancel.cancelled() => return Err(cancelled()),
        file = open(config, &original.name, original.native) => file?,
    };
    let mut file = file.take(MAX_BYTES as u64 + 1);
    let mut buffer = vec![0; 256 * 1024];
    let mut length = 0;
    let mut equal = true;
    loop {
        let count = tokio::select! { biased;
            _ = cancel.cancelled() => return Err(cancelled()),
            count = file.read(&mut buffer) => count?,
        };
        if count == 0 {
            break;
        }
        equal &= original.bytes.get(length..length + count) == Some(&buffer[..count]);
        length += count;
    }
    // Read even after a mismatch so I/O and size errors retain priority over
    // TASK_INPUT_CHANGED, without allocating a second full-size image.
    if length == 0 || length > MAX_BYTES {
        return Err(error("TASK_INPUT_INVALID", "输入图像超过 16 MiB"));
    }
    Ok(equal && length == original.bytes.len())
}
pub(super) async fn capture(
    config: &Config,
    input: &Value,
    local: bool,
    owner: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Vec<Original>> {
    let native = input["inferenceEngine"] == "native";
    let mut originals = Vec::new();
    let mut total_bytes = 0;
    for name in input_names(input) {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let bytes = Arc::new(
            tokio::select! {bytes=read(config,name,native)=>bytes?,_=cancel.cancelled()=>return Err(cancelled())},
        );
        total_bytes += bytes.len();
        if total_bytes > 64 * 1024 * 1024 { return Err(error("TASK_INPUT_INVALID", "任务输入图像合计超过 64 MiB")); }
        let (mime, _) = decode::sniff(&bytes)
            .ok_or_else(|| error("TASK_INPUT_INVALID", "任务输入不是受支持的图像"))?;
        if !local {
            let owner = owner.ok_or_else(|| {
                ApiError::new(403, "TASK_INPUT_FORBIDDEN", "图像素材需要所有者授权")
            })?;
            if !admission::owner_matches(&root(config, native), name, bytes.clone(), owner, cancel)
                .await?
            {
                return Err(ApiError::new(
                    403,
                    "TASK_INPUT_FORBIDDEN",
                    "图像素材不属于当前所有者",
                ));
            }
        }
        originals.push(Original {
            name: name.into(),
            native,
            bytes,
            mime: mime.into(),
        });
    }
    Ok(originals)
}
pub(super) async fn protect_and_restore(
    config: &Config,
    originals: &[Original],
    hooks: Option<&dyn ExecutionHooks>,
    cancel: &CancellationToken,
) -> Result<()> {
    for original in originals {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        if let Some(hooks) = hooks {
            hooks
                .protect_input(
                    original.name.clone(),
                    Output::Bytes {
                        bytes: original.bytes.clone(),
                        mime: original.mime.clone(),
                    },
                )
                .await?;
        }
        let file = path_for(config, &original.name, original.native)?;
        if !tokio::fs::try_exists(&file).await? {
            let restored = if let Some(hooks) = hooks {
                hooks
                    .restore_input(original.name.clone(), file.clone())
                    .await?
            } else {
                false
            };
            if !restored {
                // Own cleanup before the first await, including caller timeout
                // or cancellation. Publication must not overwrite another input.
                let (output, pending) =
                    tempfile::NamedTempFile::new_in(file.parent().unwrap())?.into_parts();
                let mut output = tokio::fs::File::from_std(output);
                output.write_all(original.bytes.as_slice()).await?;
                output.flush().await?;
                output.sync_all().await?;
                drop(output);
                if cancel.is_cancelled() {
                    return Err(cancelled());
                }
                if let Err(error) = pending.persist_noclobber(&file)
                    && error.error.kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(error.error.into());
                }
            }
        }
        if !matches_original(config, original, cancel).await? {
            return Err(ApiError::new(
                409,
                "TASK_INPUT_CHANGED",
                "输入图像与已保护的原始字节不一致",
            ));
        }
    }
    Ok(())
}
