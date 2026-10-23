//! Import the author checkpoint before downloading the public MOSS components.
use super::*;

pub(super) async fn stage_checkpoint(service: &ControlService, model: &ModelBundle,
    source: Option<&Path>, cancel: &CancellationToken) -> Result<()> {
    if model.id != "moss-miaomiao-base-v1.0" { return Ok(()); }
    let workspace = service.config.ai_workspace_root.join("inference");
    let target = workspace.join("models").join(&model.id);
    let root = if target.exists() { target } else {
        workspace.join(".staging").join(format!("{}-{}", model.id, model.revision))
    };
    let artifact = model.files.iter().find(|file| file.path == "transformer/diffusion_pytorch_model.safetensors")
        .ok_or_else(|| ApiError::invalid("MOSS 权重清单缺失"))?.clone();
    let destination = root.join(&artifact.path);
    if destination.exists() {
        jobs::verify_files(&root, &[artifact], cancel).await?;
        return Ok(());
    }
    let source = source.filter(|path| path.is_absolute()).ok_or_else(|| ApiError::invalid(
        "请先登录作者发布页下载 MOSS FP16 权重，再填写本机文件路径；尚未下载其他模型组件"))?.to_owned();
    let cancel = cancel.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        use std::io::{Read, Write};
        stopped(&cancel)?;
        let mut input = std::fs::File::open(&source)?;
        if !input.metadata()?.is_file() || input.metadata()?.len() != artifact.bytes {
            return Err(ApiError::invalid("请选择作者 BASE v1.0 的完整 FP16 safetensors；不支持 INT8 或未下载完成的文件"));
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
            if count == 0 { break; }
            bytes += count as u64;
            if bytes > artifact.bytes { return Err(ApiError::invalid("本机 MOSS 权重在读取时发生变化")); }
            digest.update(&buffer[..count]);
            temporary.write_all(&buffer[..count])?;
        }
        if bytes != artifact.bytes || hex::encode(digest.finalize()) != artifact.sha256 {
            return Err(ApiError::invalid("MOSS FP16 权重与作者 SHA-256 不符；原文件保留，未下载其他组件"));
        }
        temporary.as_file().sync_all()?;
        stopped(&cancel)?;
        temporary.persist_noclobber(destination).map_err(|error| ApiError::from(error.error))?;
        Ok(())
    }).await.map_err(|_| ApiError::new(503, "MODEL_IMPORT_FAILED", "MOSS 本机权重读取未完成"))?
}
