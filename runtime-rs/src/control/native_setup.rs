mod flow;
mod installer;
mod jobs;
mod plan;

use super::*;
use axum::{
    Extension, Json, Router,
    routing::{get, post},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Deserialize)]
struct Artifact {
    #[serde(alias = "filename")]
    path: String,
    url: String,
    bytes: u64,
    sha256: String,
}
#[derive(Clone, Deserialize)]
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
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    workspace_path: PathBuf,
    plan_id: String,
    reviewed: bool,
    model_id: Option<String>,
}
pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/inference/setup/plan", get(get_plan))
        .route("/api/inference/setup/prepare", post(prepare))
        .route("/api/inference/runtime/install", post(install))
        .route("/api/inference/models/download", post(download))
        .route("/api/inference/setup/activate", post(activate))
}
fn bundles() -> Result<(RuntimeBundle, Vec<ModelBundle>)> {
    let runtime: RuntimeBundle = serde_json::from_str(include_str!(
        "../../../tools/inference/managed-runtime.windows-x64.json"
    ))?;
    let models: Value =
        serde_json::from_str(include_str!("../../../tools/inference/managed-models.json"))?;
    let models: Vec<ModelBundle> = serde_json::from_value(models["models"].clone())?;
    for file in runtime
        .files
        .iter()
        .chain(models.iter().flat_map(|m| &m.files))
    {
        let path = Path::new(&file.path);
        if path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
            || file.path.contains(['\\', ':'])
            || file.bytes == 0
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !file.url.starts_with("https://")
        {
            return Err(ApiError::invalid("随包下载清单无效，请修复绘遇安装"));
        }
    }
    Ok((runtime, models))
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
    receipt.is_some_and(|value| value["modelId"] == model.id && value["revision"] == model.revision)
        && crate::generation::native::model_issue(root).is_none()
        && model.files.iter().all(|file| {
            std::fs::symlink_metadata(root.join(&file.path))
                .is_ok_and(|meta| meta.is_file() && meta.len() == file.bytes)
        })
}
fn runtime_paths(service: &ControlService, runtime: &RuntimeBundle) -> Value {
    let root = service.config.ai_workspace_root.join("inference");
    json!({"python":root.join(&runtime.runtime_id).join("venv/Scripts/python.exe"),
        "worker":service.config.app_root.join("tools/inference/worker.py"),
        "modelsRoot":root.join("models"),"lorasRoot":root.join("loras")})
}
async fn get_plan(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    Ok(Json(s.native_setup_plan().await?))
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
    s.state.lock().unwrap().operation = Some(operation.clone());
    let cancel = s.shutdown.child_token();
    *s.environment_cancel.lock().unwrap() = Some(cancel.clone());
    let (send, receive) = tokio::sync::oneshot::channel();
    // Admission, file inspection and saving survive a lost HTTP response. A
    // detached client cannot unlock a second concurrent installer/activation.
    s.clone().tasks.spawn(async move {
        let _permit = permit;
        let work = s.activate_native_settings(body, &operation, &cancel);
        tokio::pin!(work);
        let result = match tokio::time::timeout(Duration::from_secs(180), &mut work).await {
            Ok(result) => result,
            Err(_) => {
                cancel.cancel();
                let _ = work.await;
                Err(ApiError::new(
                    504,
                    "NATIVE_ACTIVATION_TIMEOUT",
                    "启用前校验超时，未确认保存；请重新读取配置后再继续",
                ))
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
impl ControlService {
    async fn activate_native_settings(
        &self,
        body: Request,
        operation: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let (runtime, models) = bundles()?;
        let reasons = plan::support(&hardware::local_hardware().await, &runtime);
        if !reasons.is_empty() {
            return Err(ApiError::new(
                409,
                "NATIVE_DEVICE_UNSUPPORTED",
                reasons.join("；"),
            ));
        }
        let model = models
            .into_iter()
            .find(|m| Some(&m.id) == body.model_id.as_ref())
            .ok_or_else(|| ApiError::invalid("请选择已登记的完整原生模型包"))?;
        let root = self
            .config
            .ai_workspace_root
            .join("inference/models")
            .join(&model.id);
        let (mut settings, receipt) =
            crate::generation::native::Settings::discovered(&self.config.ai_workspace_root);
        if receipt.is_none() || !receipt_matches(&root, &model) {
            return Err(ApiError::new(
                409,
                "NATIVE_SETUP_INCOMPLETE",
                "运行库或模型尚未完成校验，请先完成准备或重试下载",
            ));
        }
        let mut command = tokio::process::Command::new(&settings.python);
        command
            .args(["-I", "-B", "-u", "-X", "utf8"])
            .arg(&settings.worker)
            .arg("--diagnose")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONHOME")
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HUIYU_INFERENCE_ACCELERATION", "native");
        let diagnostic = self.run_setup_helper(&mut command, cancel, 120).await?;
        if diagnostic["event"] != "diagnostic" || diagnostic["cudaAvailable"] != true {
            return Err(ApiError::new(
                409,
                "NATIVE_DEVICE_UNAVAILABLE",
                "当前 CUDA 不可用，请检查 NVIDIA 驱动或重新准备运行库",
            ));
        }
        self.native_stage(operation, 1);
        jobs::verify_files(&root, &model.files, cancel).await?;
        self.validate_native_model(&settings.python, &settings.worker, &root, cancel)
            .await?;
        settings.engine = "native".into();
        settings.acceleration = "native".into();
        // The supported preparation floor uses component offload. Existing custom
        // acceleration is opt-in and is never implied by downloading the runtime.
        settings.memory_policy = "offload".into();
        let target = serde_json::to_value(&settings)?;
        let active = self.active_inference()?;
        let current = serde_json::to_value(&active)?;
        for key in &active.environment_overrides {
            if target[key] != current[key] {
                return Err(ApiError::new(
                    409,
                    "CONFIG_ENV_OVERRIDE",
                    format!("{key} 由启动环境覆盖，请移除覆盖后重启绘遇"),
                ));
            }
        }
        stopped(cancel)?;
        self.native_stage(operation, 2);
        self.patch(
            json!({"inference":target,"inferenceWorkspacePath":self.config.ai_workspace_root}),
        )
        .await?;
        self.inference_view()
    }
}
