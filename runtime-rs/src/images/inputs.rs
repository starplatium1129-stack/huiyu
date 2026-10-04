use super::*;
use regex::Regex;
use std::sync::LazyLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
static NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^aics_anima_input_[a-f0-9]{16,40}\.(?:png|jpg|jpeg|webp)$").unwrap()
});
pub(super) struct Original {
    pub name: String,
    pub bytes: Arc<Vec<u8>>,
    pub mime: String,
}
pub(super) fn cancelled() -> ApiError {
    ApiError::new(499, "CANCELLED", "图像操作已取消")
}
pub(super) fn path(config: &Config, name: &str) -> Result<PathBuf> {
    if !NAME.is_match(name) {
        return Err(error("TASK_INPUT_INVALID", "输入图像文件名无效"));
    }
    Ok(config.ai_workspace_root.join("ComfyUI/input").join(name))
}
async fn read(config: &Config, name: &str) -> Result<Vec<u8>> {
    let file = path(config, name)?;
    let root = tokio::fs::canonicalize(config.ai_workspace_root.join("ComfyUI/input")).await?;
    let target = tokio::fs::canonicalize(&file).await?;
    if !target.starts_with(&root) || target == root {
        return Err(error("TASK_INPUT_INVALID", "输入图像超出授权目录"));
    }
    let file = tokio::fs::File::open(file).await?;
    if !file.metadata().await?.is_file() {
        return Err(error("TASK_INPUT_INVALID", "输入图像不是普通文件"));
    }
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err(error("TASK_INPUT_INVALID", "输入图像超过 16 MiB"));
    }
    Ok(bytes)
}
pub(super) async fn capture(
    config: &Config,
    input: &Value,
    local: bool,
    owner: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Vec<Original>> {
    let mut originals = Vec::new();
    let mut names = std::collections::HashSet::new();
    for key in ["initImage", "maskImage"] {
        let Some(name) = input[key].as_str() else {
            continue;
        };
        if !names.insert(name) {
            continue;
        }
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let bytes = tokio::select! {bytes=read(config,name)=>bytes?,_=cancel.cancelled()=>return Err(cancelled())};
        let (mime, _) = decode::sniff(&bytes)
            .ok_or_else(|| error("TASK_INPUT_INVALID", "任务输入不是受支持的图像"))?;
        if !local {
            let owner = owner.ok_or_else(|| {
                ApiError::new(403, "TASK_INPUT_FORBIDDEN", "图像素材需要所有者授权")
            })?;
            if !admission::owner_matches(
                &config.ai_workspace_root.join("ComfyUI/input"),
                name,
                &bytes,
                owner,
            )
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
            bytes: Arc::new(bytes),
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
        let file = path(config, &original.name)?;
        if !tokio::fs::try_exists(&file).await? {
            let restored = if let Some(hooks) = hooks {
                hooks
                    .restore_input(original.name.clone(), file.clone())
                    .await?
            } else {
                false
            };
            if !restored {
                let pending = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
                let mut output = tokio::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&pending)
                    .await?;
                let result = async {
                    output.write_all(original.bytes.as_slice()).await?;
                    output.flush().await?;
                    output.sync_all().await?;
                    drop(output);
                    tokio::fs::hard_link(&pending, &file).await
                }
                .await;
                let _ = tokio::fs::remove_file(pending).await;
                if let Err(error) = result
                    && error.kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(error.into());
                }
            }
        }
        if read(config, &original.name).await?.as_slice() != original.bytes.as_slice() {
            return Err(ApiError::new(
                409,
                "TASK_INPUT_CHANGED",
                "输入图像与已保护的原始字节不一致",
            ));
        }
    }
    Ok(())
}
