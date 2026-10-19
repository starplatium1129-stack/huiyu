//! Image-only managed bundles; gated credentials never enter persisted state.
use super::*;
use crate::generation::native::{Settings, adapters, resources};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};

pub(super) fn is_adapter_runtime(runtime: &RuntimeBundle) -> bool {
    runtime.runtime_id == "cpython3119-torch280-cu128-images-v1"
}
pub(super) fn runtime_for(model: Option<&str>) -> Result<Arc<RuntimeBundle>> {
    if !model.is_some_and(|id| adapters::model(id).is_some_and(|spec| spec["media"] == "image")) {
        return runtime_bundle();
    }
    static RUNTIME: LazyLock<Result<Arc<RuntimeBundle>>> = LazyLock::new(|| {
        let value: RuntimeBundle = serde_json::from_str(include_str!("../../../../tools/inference/managed-adapter-runtime.windows-x64.json"))?;
        validate_artifacts(&value.files)?;
        Ok(Arc::new(value))
    });
    RUNTIME.as_ref().cloned().map_err(|e| ApiError::new(e.status.as_u16(), &e.code, &e.message))
}
pub(super) fn manifest_hash(runtime: &RuntimeBundle) -> String {
    if is_adapter_runtime(runtime) {
        hex::encode(Sha256::digest(include_bytes!("../../../../tools/inference/managed-adapter-runtime.windows-x64.json")))
    } else { runtime_manifest_sha256().to_owned() }
}
pub(super) fn runtime_receipt(service: &ControlService, runtime: &RuntimeBundle) -> Option<(PathBuf, Value)> {
    let root = service.config.ai_workspace_root.join("inference").join(&runtime.runtime_id);
    let worker = service.config.app_root.join("tools/inference/worker.py");
    let requirements = if is_adapter_runtime(runtime) { "requirements-adapters.txt" } else { "requirements.txt" };
    let receipt = crate::generation::native::installed_runtime_for(&root, &worker, requirements)?;
    (receipt.1["managedRuntimeId"] == runtime.runtime_id && receipt.1["manifestSha256"] == manifest_hash(runtime)).then_some(receipt)
}
pub(super) fn settings(service: &ControlService, runtime: &RuntimeBundle) -> Result<Settings> {
    let (_, receipt) = runtime_receipt(service, runtime).ok_or_else(|| ApiError::new(409, "NATIVE_RUNTIME_UNAVAILABLE", "所选模型的独立运行库尚未准备完成"))?;
    let (mut settings, _) = Settings::discovered(&service.config.ai_workspace_root);
    settings.python = PathBuf::from(receipt["python"].as_str().unwrap());
    if is_adapter_runtime(runtime) { settings.worker = settings.worker.with_file_name("adapter_worker.py"); }
    settings.acceleration = "native".into();
    settings.memory_policy = "offload".into();
    Ok(settings)
}
pub(super) fn model_issue(root: &Path, id: &str) -> Option<String> {
    if adapters::model(id).is_some() { adapters::model_issue(root, id) }
    else { crate::generation::native::model_issue(root) }
}
pub(super) fn token_header(token: Option<&str>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    if let Some(token) = token.filter(|s| !s.is_empty()) {
        if token.len() > 512 || !token.starts_with("hf_") || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err(ApiError::invalid("请输入有效的 Hugging Face 只读访问令牌"));
        }
        let mut value = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| ApiError::invalid("访问令牌格式无效"))?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }
    Ok(headers)
}
fn git_blob(bytes: &[u8]) -> String {
    let mut hash = sha1::Sha1::new();
    hash.update(format!("blob {}\0", bytes.len()).as_bytes());
    hash.update(bytes);
    hex::encode(hash.finalize())
}
fn pointer(file: &Artifact, sha: &str) -> bool {
    sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()) && git_blob(format!(
        "version https://git-lfs.github.com/spec/v1\noid sha256:{sha}\nsize {}\n", file.bytes).as_bytes()) == file.git_blob_id
}
pub(super) fn cached_artifacts(root: &Path, model: &ModelBundle) -> Vec<Artifact> {
    let cache = root.join(".downloads/model-identities").join(&model.revision);
    let mut files = model.files.clone();
    for file in &mut files {
        if !file.lfs || !file.sha256.is_empty() { continue; }
        let Some(path) = resources::file(&cache, &file.git_blob_id, true) else { continue; };
        if !std::fs::metadata(&path).is_ok_and(|m| m.len() <= 1024) { continue; }
        let Ok(text) = std::fs::read_to_string(path) else { continue; };
        let sha = text.lines().find_map(|line| line.strip_prefix("oid sha256:")).unwrap_or("");
        if pointer(file, sha) { file.sha256 = sha.into(); }
    }
    files
}

// Public gated listings conceal LFS hashes. Resolve only fixed-revision raw
// blobs after user authorization; Git object IDs bind both pointers and configs.
// The small local pointer cache supports offline continuation and activation.
pub(super) async fn resolve_files(service: &ControlService, model: &ModelBundle, root: &Path,
    token: Option<&str>, cancel: &CancellationToken) -> Result<Vec<Artifact>> {
    let client = reqwest::Client::builder().https_only(true).timeout(Duration::from_secs(60))
        .default_headers(token_header(token)?).build().map_err(|_| ApiError::new(502, "DOWNLOAD_FAILED", "无法建立模型连接"))?;
    let cache = service.config.ai_workspace_root.join("inference/.downloads/model-identities").join(&model.revision);
    let mut files = model.files.clone();
    for file in &mut files {
        stopped(cancel)?;
        if !file.sha256.is_empty() { continue; }
        let cached = cache.join(&file.git_blob_id);
        plan::safe_directory(&cache)?;
        let local = if file.lfs { None } else { resources::file(root, &file.path, true) }
            .or_else(|| resources::file(&cache, &file.git_blob_id, true));
        let limit = if file.lfs { 1024 } else { file.bytes.min(32 * 1024 * 1024) };
        let mut bytes = if let Some(path) = local {
            if std::fs::metadata(&path).is_ok_and(|m| m.len() <= limit) { tokio::fs::read(path).await.ok() } else { None }
        } else { None };
        if bytes.as_ref().is_none_or(|b| git_blob(b) != file.git_blob_id) {
            if !file.url.starts_with("https://huggingface.co/") {
                return Err(ApiError::invalid("模型来源不在固定 Hugging Face 清单内"));
            }
            let url = file.url.replacen("/resolve/", "/raw/", 1);
            let request = async {
                let mut response = client.get(url).send().await.map_err(|_| ApiError::new(502, "DOWNLOAD_FAILED", "模型授权或来源暂不可连接"))?;
                if !response.status().is_success() {
                    return Err(ApiError::new(403, "MODEL_ACCESS_REQUIRED", "无法读取所选模型。请在模型来源页面接受许可并取得访问权，再填写该仓库的只读 Hugging Face 令牌后重试"));
                }
                let mut data = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|_| ApiError::new(502, "DOWNLOAD_FAILED", "模型清单读取中断"))? {
                    if data.len() + chunk.len() > limit as usize { return Err(ApiError::invalid("模型配置超过固定大小")); }
                    data.extend_from_slice(&chunk);
                }
                Ok(data)
            };
            bytes = Some(tokio::select! { _ = cancel.cancelled() => { stopped(cancel)?; unreachable!() }, result = request => result? });
        }
        let data = bytes.unwrap();
        if git_blob(&data) != file.git_blob_id { return Err(ApiError::new(409, "MODEL_SOURCE_CHANGED", "模型组件与已确认的固定版本不一致")); }
        if file.lfs {
            let text = std::str::from_utf8(&data).map_err(|_| ApiError::invalid("模型权重指针无效"))?;
            let sha = text.lines().find_map(|line| line.strip_prefix("oid sha256:")).unwrap_or("");
            if !pointer(file, sha) { return Err(ApiError::invalid("模型权重指针大小或摘要无效")); }
            file.sha256 = sha.into();
        } else {
            if data.len() as u64 != file.bytes { return Err(ApiError::invalid("模型配置大小与固定清单不一致")); }
            file.sha256 = hex::encode(Sha256::digest(&data));
        }
        // Cache only a bounded model blob, never the access token or model weights.
        plan::safe_directory(&cache)?;
        tokio::fs::create_dir_all(&cache).await?;
        if !cached.exists() {
            use std::io::Write;
            let mut temp = tempfile::NamedTempFile::new_in(&cache)?;
            temp.write_all(&data)?;
            temp.persist_noclobber(&cached).map_err(|e| ApiError::from(e.error))?;
        }
    }
    Ok(files)
}
