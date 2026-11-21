mod activation;
mod anima_models;
mod checkpoint_models;
mod downloads;
mod flow;
mod image_models;
mod image_resources;
mod installer;
mod jobs;
mod local_adapters;
mod moss_models;
mod pixai;
mod plan;

use super::*;
use axum::{
    Extension, Json, Router,
    extract::Query,
    routing::{get, post},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
};
use tokio::sync::OwnedSemaphorePermit;

#[derive(Clone, Deserialize)]
struct Artifact {
    #[serde(default)]
    kind: String,
    #[serde(alias = "filename")]
    path: String,
    url: String,
    bytes: u64,
    sha256: String,
    #[serde(default, rename = "gitBlobId")]
    git_blob_id: String,
    #[serde(default)]
    lfs: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBundle {
    runtime_id: String,
    download_bytes: u64,
    required_free_bytes: u64,
    minimum_nvidia_driver: String,
    minimum_windows_build: u64,
    sources: Value,
    files: Vec<Artifact>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelBundle {
    id: String,
    label: String,
    revision: String,
    license: String,
    license_url: String,
    source_url: String,
    required_bytes: u64,
    files: Vec<Artifact>,
    #[serde(default)]
    requires_access: bool,
    #[serde(default)]
    conversion_profile: Option<String>,
    #[serde(default)]
    checkpoint_filename: Option<String>,
    #[serde(default)]
    requires_local_checkpoint: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation_id: Option<String>,
    workspace_path: PathBuf,
    plan_id: String,
    reviewed: bool,
    model_id: Option<String>,
    // Request-local credential: never put it in operation snapshots or config.
    hf_token: Option<String>,
    checkpoint_path: Option<PathBuf>,
    resource_root: Option<PathBuf>,
    #[serde(default)]
    local_video_import: bool,
}
pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/inference/setup/plan", get(get_plan))
        .route("/api/inference/setup/prepare", post(prepare))
        .route("/api/inference/runtime/install", post(install))
        .route("/api/inference/models/download", post(download))
        .route(
            "/api/inference/resources/download",
            post(image_resources::download),
        )
        .route("/api/inference/setup/activate", post(activate))
        .merge(pixai::routes())
}
fn bundles() -> Result<(Arc<RuntimeBundle>, Vec<Arc<ModelBundle>>)> {
    let runtime = runtime_bundle()?;
    static MODELS: LazyLock<Result<Vec<Arc<ModelBundle>>>> = LazyLock::new(|| {
        let models: Value =
            serde_json::from_str(include_str!("../../../tools/inference/managed-models.json"))?;
        let complete = Vec::<ModelBundle>::deserialize(&models["models"])?;
        let base = complete
            .iter()
            .find(|model| model.id == "anima-base-v1.0")
            .ok_or_else(|| ApiError::invalid("缺少 Anima 基础组件清单"))?;
        let mut models = Vec::new();
        let sources = setup_verify::model_manifest()?;
        for source in sources["files"]
            .as_array()
            .ok_or_else(|| ApiError::invalid("缺少模型来源清单"))?
        {
            if let Some(profile) = source.get("nativeConversionProfile") {
                let profile = profile
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("原生转换规格无效"))?;
                models.push(anima_models::bundle(base, source, profile)?);
            }
        }
        models.sort_by_key(|model| model.id != setup::RECOMMENDED_MODEL);
        models.extend(complete);
        let adapters: Value = serde_json::from_str(include_str!(
            "../../../tools/inference/managed-adapter-models.json"
        ))?;
        models.extend(Vec::<ModelBundle>::deserialize(&adapters["models"])?);
        let mut ids = std::collections::HashSet::new();
        for model in &mut models {
            if !ids.insert(model.id.clone()) {
                return Err(ApiError::invalid(format!("原生模型 ID 重复：{}", model.id)));
            }
            moss_models::prepare_bundle(model)?;
            validate_artifacts(&model.files)?;
        }
        Ok(models.into_iter().map(Arc::new).collect())
    });
    let models = MODELS
        .as_ref()
        .cloned()
        .map_err(|e| ApiError::new(e.status.as_u16(), &e.code, &e.message))?;
    Ok((runtime, models))
}
fn runtime_bundle() -> Result<Arc<RuntimeBundle>> {
    static RUNTIME: LazyLock<Result<Arc<RuntimeBundle>>> = LazyLock::new(|| {
        let runtime: RuntimeBundle = serde_json::from_str(include_str!(
            "../../../tools/inference/managed-runtime.windows-x64.json"
        ))?;
        validate_artifacts(&runtime.files)?;
        Ok(Arc::new(runtime))
    });
    RUNTIME
        .as_ref()
        .cloned()
        .map_err(|e| ApiError::new(e.status.as_u16(), &e.code, &e.message))
}
fn runtime_manifest_sha256() -> &'static str {
    static HASH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        hex::encode(Sha256::digest(include_bytes!(
            "../../../tools/inference/managed-runtime.windows-x64.json"
        )))
    });
    HASH.as_str()
}
fn validate_artifacts(files: &[Artifact]) -> Result<()> {
    for file in files {
        let path = Path::new(&file.path);
        if path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
            || file.path.contains(['\\', ':'])
            || file.bytes == 0
            || !(file.sha256.len() == 64
                && file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                || file.sha256.is_empty()
                    && file.git_blob_id.len() == 40
                    && file
                        .git_blob_id
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit()))
            || !file.url.starts_with("https://")
        {
            return Err(ApiError::invalid("随包下载清单无效，请修复绘遇安装"));
        }
    }
    Ok(())
}
fn plan_id(workspace: &Path) -> String {
    let mut hash = Sha256::new();
    hash.update(workspace.to_string_lossy().as_bytes());
    hash.update(include_bytes!(
        "../../../tools/inference/managed-runtime.windows-x64.json"
    ));
    hash.update(include_bytes!(
        "../../../tools/inference/managed-models.json"
    ));
    hash.update(include_bytes!(
        "../../../tools/inference/managed-adapter-runtime.windows-x64.json"
    ));
    hash.update(include_bytes!(
        "../../../tools/inference/managed-adapter-models.json"
    ));
    hash.update(include_bytes!(
        "../../../tools/inference/managed-image-resources.json"
    ));
    hash.update(include_bytes!(
        "../../../tools/inference/managed-auxiliary-models.json"
    ));
    hash.update(include_bytes!("setup-models.json"));
    hash.update(include_bytes!(
        "../../../tools/inference/adapter-models.json"
    ));
    hash.update(include_bytes!("../../../tools/inference/wan22-import.json"));
    hex::encode(hash.finalize())
}
fn check_request(service: &ControlService, request: &Request) -> Result<()> {
    if !request.reviewed
        || request.workspace_path != service.config.ai_workspace_root
        || request.plan_id != plan_id(&service.config.ai_workspace_root)
    {
        return Err(ApiError::new(
            409,
            "WORKSPACE_CHANGED",
            "工作区或下载清单已改变，请重新检查并确认",
        ));
    }
    image_models::token_header(request.hf_token.as_deref())?;
    Ok(())
}
fn stopped(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(ApiError::new(
            499,
            "CANCELLED",
            "操作已取消；已校验文件与可续传下载保留，可重新确认后继续",
        ))
    } else {
        Ok(())
    }
}
fn receipt_matches(root: &Path, model: &ModelBundle) -> bool {
    installation_source(root, model).is_some()
}

fn installation_source(root: &Path, model: &ModelBundle) -> Option<&'static str> {
    let path = root.join("huiyu-model.json");
    let mut receipt = std::fs::symlink_metadata(&path).ok()
        .filter(|meta| meta.is_file() && meta.len() < 65536)
        .and_then(|_| std::fs::read(&path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())?;
    if receipt["modelId"] != model.id || image_models::model_issue(root, &model.id).is_some() {
        return None;
    }
    if model.id == "krea2-turbo" && receipt["scope"] == "local-fp8-dequantized-bf16" {
        return local_adapters::krea_receipt(root, &receipt).then_some("local");
    }
    if receipt["revision"] != model.revision { return None; }
    if receipt["scope"] == "converted-local-weights-sha256" {
        return local_adapters::video_receipt(root, &model.id, &mut receipt).then_some("local");
    }
    let ready = if model.conversion_profile.is_some() {
        anima_models::parse_outputs(receipt["outputs"].take()).is_ok_and(|files| {
            files.iter().all(|file| {
                std::fs::symlink_metadata(root.join(&file.path))
                    .is_ok_and(|meta| meta.is_file() && meta.len() == file.bytes)
            })
        })
    } else if moss_models::is_moss(model) {
        moss_models::ready(root, model, &receipt)
    } else {
        model.files.iter().all(|file| {
            std::fs::symlink_metadata(root.join(&file.path))
                .is_ok_and(|meta| meta.is_file() && meta.len() == file.bytes)
        })
    };
    ready.then_some("managed")
}
fn runtime_paths(service: &ControlService, runtime: &RuntimeBundle) -> Value {
    let root = service.config.ai_workspace_root.join("inference");
    json!({"python":root.join(&runtime.runtime_id).join("venv/Scripts/python.exe"),
        "worker":service.config.app_root.join(if image_models::is_adapter_runtime(runtime) { "tools/inference/adapter_worker.py" } else { "tools/inference/worker.py" }),
        "modelsRoot":root.join("models"),"lorasRoot":root.join("loras")})
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanQuery {
    model_id: Option<String>,
}
async fn get_plan(
    Extension(s): Extension<Arc<ControlService>>,
    Query(query): Query<PlanQuery>,
) -> Result<Json<Value>> {
    Ok(Json(s.native_setup_plan(query.model_id.as_deref()).await?))
}
async fn prepare(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Request>,
) -> Result<Json<Value>> {
    Ok(Json(s.start_native_preparation(body).await?))
}
async fn install(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Request>,
) -> Result<Json<Value>> {
    Ok(Json(s.start_native_setup(body, false).await?))
}
async fn download(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Request>,
) -> Result<Json<Value>> {
    Ok(Json(s.start_native_setup(body, true).await?))
}
async fn activate(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Request>,
) -> Result<Json<Value>> {
    check_request(&s, &body)?;
    let permit = s.setup_permit()?;
    let mut operation = s.begin(
        "activate-native-engine",
        &["检查当前设备与依赖", "校验完整模型", "保存原生引擎配置"],
    )?;
    operation["workspacePath"] = json!(body.workspace_path);
    s.publish_operation(operation.clone())?;
    let cancel = s.shutdown.child_token();
    *s.environment_cancel.lock().unwrap() = Some(cancel.clone());
    let (send, receive) = tokio::sync::oneshot::channel();
    // Admission, file inspection and saving survive a lost HTTP response. A
    // detached client cannot unlock a second concurrent installer/activation.
    s.clone().tasks.spawn(async move {
        let work = s.activate_native_settings(body, &operation, &cancel, &permit);
        tokio::pin!(work);
        let result = match tokio::time::timeout(Duration::from_secs(180), &mut work).await {
            Ok(result) => result,
            Err(_) => {
                cancel.cancel();
                match work.await {
                    Err(error) if error.code == "TERMINATION_UNCONFIRMED" => Err(error),
                    _ => Err(ApiError::new(
                        504,
                        "NATIVE_ACTIVATION_TIMEOUT",
                        "启用配置保存超时，请重新读取配置确认结果",
                    )),
                }
            }
        };
        s.environment_cancel.lock().unwrap().take();
        s.finish(
            &operation,
            result
                .as_ref()
                .map(|_| ())
                .map_err(|error| ApiError::new(error.status.as_u16(), &error.code, &error.message)),
        );
        let _ = send.send(result);
    });
    Ok(Json(receive.await.map_err(|_| {
        ApiError::new(
            503,
            "NATIVE_ACTIVATION_INTERRUPTED",
            "启用状态未确认，请重新检查",
        )
    })??))
}
