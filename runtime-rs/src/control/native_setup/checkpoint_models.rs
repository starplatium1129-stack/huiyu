//! Reuse verified local checkpoints before downloading public components.
use super::*;
use crate::control::setup_verify::{self, ModelFile};

pub(super) struct LocalCheckpoint {
    pub(super) artifact: String,
    pub(super) path: PathBuf,
    pub(super) guard: Option<Arc<std::fs::File>>,
}

pub(super) fn conversion_checkpoint(model: &ModelBundle) -> Option<&Artifact> {
    model.conversion_profile.as_ref()?;
    model
        .files
        .iter()
        .find(|file| file.path == "checkpoint.safetensors")
}

pub(super) fn workspace_checkpoint(workspace: &Path, model: &ModelBundle) -> Option<PathBuf> {
    let artifact = conversion_checkpoint(model)?;
    let spec = setup_verify::model_file(&model.id).ok()?;
    if spec.bytes != artifact.bytes || spec.sha256 != artifact.sha256 {
        return None;
    }
    let path = setup_verify::model_root(workspace, &model.id)
        .ok()?
        .join(&spec.path);
    std::fs::metadata(&path)
        .ok()
        .filter(|meta| meta.is_file() && meta.len() == spec.bytes)?;
    Some(path)
}

pub(super) async fn stage_checkpoint(
    service: &ControlService,
    model: &ModelBundle,
    source: Option<&Path>,
    operation: &Value,
    cancel: &CancellationToken,
) -> Result<Option<LocalCheckpoint>> {
    let Some(filename) = model.checkpoint_filename.as_ref() else {
        return Ok(None);
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
    let artifact = conversion_checkpoint(model)
        .or_else(|| {
            model.files.iter().find(|file| {
                file.url
                    .starts_with("https://civitai.com/api/download/models/")
            })
        })
        .ok_or_else(|| ApiError::invalid("作者权重清单缺失"))?
        .clone();
    let destination = root.join(&artifact.path);
    if model.conversion_profile.is_some() {
        let reuse = source.map(Path::to_owned).or_else(|| {
            (!destination.exists())
                .then(|| workspace_checkpoint(&service.config.ai_workspace_root, model))
                .flatten()
        });
        if let Some(path) = reuse {
            service.native_progress(
                operation,
                json!({"message":"正在核对本机作者权重，校验通过后直接用于转换"}),
            );
            let checked = verify_conversion_input(service, path, &artifact, cancel).await;
            match checked {
                Ok(value) => {
                    service.native_progress(operation, json!({"message":"已采用本机作者权重"}));
                    return Ok(Some(value));
                }
                Err(error) if source.is_some() || cancel.is_cancelled() => return Err(error),
                Err(_) => {}
            }
        }
    }
    if destination.exists() {
        // Existing inputs are verified once by the normal model downloader.
        return Ok(None);
    }
    if source.is_none() && !model.requires_local_checkpoint {
        return Ok(None);
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
    tokio::task::spawn_blocking(move || -> Result<Option<LocalCheckpoint>> {
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
            .persist_noclobber(&destination)
            .map_err(|error| ApiError::from(error.error))?;
        Ok(Some(LocalCheckpoint {
            artifact: artifact.path,
            path: destination,
            guard: None,
        }))
    })
    .await
    .map_err(|_| ApiError::new(503, "MODEL_IMPORT_FAILED", "本机作者权重读取未完成"))?
}

async fn verify_conversion_input(
    service: &ControlService,
    path: PathBuf,
    artifact: &Artifact,
    cancel: &CancellationToken,
) -> Result<LocalCheckpoint> {
    if !path.is_absolute() {
        return Err(ApiError::invalid("请选择本机作者原始权重的绝对路径"));
    }
    let artifact = artifact.clone();
    let cancel = cancel.clone();
    #[cfg(windows)]
    let checks = service.setup_archives.clone();
    #[cfg(not(windows))]
    let _ = service;
    tokio::task::spawn_blocking(move || {
        stopped(&cancel)?;
        let path = path.canonicalize()?;
        let root = path
            .parent()
            .ok_or_else(|| ApiError::invalid("无效的权重路径"))?;
        #[cfg(windows)]
        let (file, checked) = checks.hold(&path, root, &artifact.sha256)?;
        #[cfg(not(windows))]
        let (file, checked) = (std::fs::File::open(&path)?, false);
        let spec = ModelFile {
            path: path.file_name().unwrap().to_string_lossy().into_owned(),
            bytes: artifact.bytes,
            sha256: artifact.sha256.clone(),
        };
        let (send, _receive) = tokio::sync::mpsc::unbounded_channel();
        let meta = file.metadata()?;
        let valid = meta.is_file()
            && meta.len() == spec.bytes
            && (checked
                || setup_verify::inspect(root, &spec, "local-checkpoint", &send, &cancel)["state"]
                    == "sha256-match");
        stopped(&cancel)?;
        if !valid {
            return Err(ApiError::invalid(
                "本机权重与登记的大小或 SHA-256 不符，请选择作者提供的原始完整文件",
            ));
        }
        #[cfg(windows)]
        if !checked && let Ok(identity) = crate::file_identity::opened(&file) {
            checks.record(path.clone(), artifact.sha256, identity, &file);
        }
        Ok(LocalCheckpoint {
            artifact: artifact.path,
            path,
            guard: Some(Arc::new(file)),
        })
    })
    .await
    .map_err(|_| ApiError::new(503, "MODEL_IMPORT_FAILED", "本机作者权重读取未完成"))?
}
