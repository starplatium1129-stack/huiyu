//! Import a fixed author checkpoint before downloading public components.
use super::*;

pub(super) async fn stage_checkpoint(
    service: &ControlService,
    model: &ModelBundle,
    source: Option<&Path>,
    cancel: &CancellationToken,
) -> Result<()> {
    let Some(filename) = model.checkpoint_filename.as_ref() else {
        return Ok(());
    };
    let workspace = service.config.ai_workspace_root.join("inference");
    let target = workspace.join("models").join(&model.id);
    let root = if model.conversion_profile.is_some() {
        anima_models::input_root(&target, model)
    } else if target.exists() {
        target
    } else {
        workspace
            .join(".staging")
            .join(format!("{}-{}", model.id, model.revision))
    };
    let artifact = model
        .files
        .iter()
        .find(|file| {
            file.url
                .starts_with("https://civitai.com/api/download/models/")
        })
        .ok_or_else(|| ApiError::invalid("作者权重清单缺失"))?
        .clone();
    let destination = root.join(&artifact.path);
    if destination.exists() {
        jobs::verify_files(&root, &[artifact], cancel).await?;
        return Ok(());
    }
    // 2B checkpoints support either automatic download or an existing file.
    // The 2.9B author flow still requires a locally downloaded checkpoint.
    if source.is_none() && model.conversion_profile.as_deref() == Some("anima-cosmos2b-v041") {
        return Ok(());
    }
    let source = source
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            ApiError::invalid(&format!(
                "请先登录作者发布页下载 {filename}，再填写本机文件路径；尚未下载其他模型组件"
            ))
        })?
        .to_owned();
    let filename = filename.clone();
    let cancel = cancel.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        use std::io::{Read, Write};
        stopped(&cancel)?;
        let mut input = std::fs::File::open(&source)?;
        if !input.metadata()?.is_file() || input.metadata()?.len() != artifact.bytes {
            return Err(ApiError::invalid(&format!(
                "请选择作者原始完整文件 {filename}；文件大小不符，不支持量化或未下载完成的文件"
            )));
        }
        let parent = destination.parent().unwrap();
        plan::safe_directory(parent)?;
        std::fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0u8; 8 * 1024 * 1024];
        let mut bytes = 0u64;
        loop {
            stopped(&cancel)?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes += count as u64;
            if bytes > artifact.bytes {
                return Err(ApiError::invalid("本机作者权重在读取时发生变化"));
            }
            digest.update(&buffer[..count]);
            temporary.write_all(&buffer[..count])?;
        }
        if bytes != artifact.bytes || hex::encode(digest.finalize()) != artifact.sha256 {
            return Err(ApiError::invalid(
                "本机权重与作者 SHA-256 不符；原文件保留，未下载其他组件",
            ));
        }
        temporary.as_file().sync_all()?;
        stopped(&cancel)?;
        temporary
            .persist_noclobber(destination)
            .map_err(|error| ApiError::from(error.error))?;
        Ok(())
    })
    .await
    .map_err(|_| ApiError::new(503, "MODEL_IMPORT_FAILED", "本机作者权重读取未完成"))?
}
