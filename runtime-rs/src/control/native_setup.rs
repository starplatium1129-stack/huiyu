mod flow;
mod installer;
mod jobs;
mod pixai;
mod plan;
mod image_models;
mod activation;
mod image_resources;
mod anima_models;

use super::*;
use axum::{
    Extension, Json, Router, extract::Query,
    routing::{get, post},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, sync::LazyLock};
use tokio::sync::OwnedSemaphorePermit;

#[derive(Clone, Deserialize)]
struct Artifact {
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
    resource_root: Option<PathBuf>,
}
pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/inference/setup/plan", get(get_plan))
        .route("/api/inference/setup/prepare", post(prepare))
        .route("/api/inference/runtime/install", post(install))
        .route("/api/inference/models/download", post(download))
        .route("/api/inference/resources/download", post(image_resources::download))
        .route("/api/inference/setup/activate", post(activate))
        .merge(pixai::routes())
}
fn bundles() -> Result<(Arc<RuntimeBundle>, Vec<Arc<ModelBundle>>)> {
    let runtime = runtime_bundle()?;
    static MODELS: LazyLock<Result<Vec<Arc<ModelBundle>>>> = LazyLock::new(|| {
        let models: Value =
            serde_json::from_str(include_str!("../../../tools/inference/managed-models.json"))?;
        let mut models = Vec::<ModelBundle>::deserialize(&models["models"])?;
        let miaomiao = anima_models::bundle(&models[0])?;
        models.insert(0, miaomiao);
        let adapters: Value = serde_json::from_str(include_str!("../../../tools/inference/managed-adapter-models.json"))?;
        models.extend(Vec::<ModelBundle>::deserialize(&adapters["models"])?);
        for model in &models {
            validate_artifacts(&model.files)?;
        }
        Ok(models.into_iter().map(Arc::new).collect())
    });
    let models = MODELS.as_ref().cloned()
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
    RUNTIME.as_ref().cloned()
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
            || !(file.sha256.len() == 64 && file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                || file.sha256.is_empty() && file.git_blob_id.len() == 40 && file.git_blob_id.bytes().all(|byte| byte.is_ascii_hexdigit()))
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
    hash.update(include_bytes!("../../../tools/inference/managed-adapter-runtime.windows-x64.json"));
    hash.update(include_bytes!("../../../tools/inference/managed-adapter-models.json"));
    hash.update(include_bytes!("../../../tools/inference/managed-image-resources.json"));
    hash.update(include_bytes!("../../../tools/inference/managed-auxiliary-models.json"));
    hash.update(include_bytes!("setup-models.json"));
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
    let receipt = std::fs::read(root.join("huiyu-model.json"))
        .ok()
        .filter(|bytes| bytes.len() < 65536)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let inputs = anima_models::input_root(root, model);
    receipt.is_some_and(|value| value["modelId"] == model.id && value["revision"] == model.revision)
        && image_models::model_issue(root, &model.id).is_none()
        && model.files.iter().all(|file| {
            std::fs::symlink_metadata(inputs.join(&file.path))
                .is_ok_and(|meta| meta.is_file() && meta.len() == file.bytes)
        })
        && (model.conversion_profile.is_none() || anima_models::output_files(root).is_ok_and(|files| {
            files.iter().all(|file| std::fs::symlink_metadata(root.join(&file.path))
                .is_ok_and(|meta| meta.is_file() && meta.len() == file.bytes))
        }))
}
fn runtime_paths(service: &ControlService, runtime: &RuntimeBundle) -> Value {
    let root = service.config.ai_workspace_root.join("inference");
    json!({"python":root.join(&runtime.runtime_id).join("venv/Scripts/python.exe"),
        "worker":service.config.app_root.join(if image_models::is_adapter_runtime(runtime) { "tools/inference/adapter_worker.py" } else { "tools/inference/worker.py" }),
        "modelsRoot":root.join("models"),"lorasRoot":root.join("loras")})
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanQuery { model_id: Option<String> }
async fn get_plan(Extension(s): Extension<Arc<ControlService>>, Query(query): Query<PlanQuery>) -> Result<Json<Value>> {
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
                        "启用前校验超时，未确认保存；请重新读取配置后再继续",
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
