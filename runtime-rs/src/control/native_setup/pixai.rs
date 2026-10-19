mod flow;

use super::*;
use axum::extract::State;
use std::io::Read;

#[derive(Deserialize)]
struct Manifest {
    repo: String,
    revision: String,
    files: Vec<ModelFile>,
    timm: Timm,
}
#[derive(Deserialize)]
struct ModelFile {
    path: String,
    bytes: u64,
    sha256: String,
}
#[derive(Deserialize)]
struct Timm {
    version: String,
    #[serde(flatten)]
    file: Artifact,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    workspace_path: PathBuf,
    plan_id: String,
    reviewed: bool,
}
pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/interrogate/setup/plan", get(get_plan))
        .route("/api/interrogate/setup/prepare", post(prepare))
}
fn load_manifest() -> Result<Arc<Manifest>> {
    static MANIFEST: LazyLock<Result<Arc<Manifest>>> = LazyLock::new(|| {
        Ok(Arc::new(serde_json::from_str(include_str!(
            "../../../../tools/interrogate/pixai-manifest.json"
        ))?))
    });
    MANIFEST.as_ref().cloned()
        .map_err(|e| ApiError::new(e.status.as_u16(), &e.code, &e.message))
}
fn artifacts() -> Result<Arc<Vec<Artifact>>> {
    static ARTIFACTS: LazyLock<Result<Arc<Vec<Artifact>>>> = LazyLock::new(|| {
        let manifest = load_manifest()?;
        let mut files: Vec<_> = manifest
            .files
            .iter()
            .map(|file| Artifact {
                path: format!("model/{}", file.path),
                url: format!(
                    "https://huggingface.co/{}/resolve/{}/{}",
                    manifest.repo, manifest.revision, file.path
                ),
                bytes: file.bytes,
                sha256: file.sha256.clone(),
            })
            .collect();
        let mut wheel = manifest.timm.file.clone();
        wheel.path = format!("wheels/{}", wheel.path);
        files.push(wheel);
        validate_artifacts(&files)?;
        Ok(Arc::new(files))
    });
    ARTIFACTS.as_ref().cloned()
        .map_err(|e| ApiError::new(e.status.as_u16(), &e.code, &e.message))
}
fn fingerprint(service: &ControlService) -> String {
    let mut hash = Sha256::new();
    hash.update(
        service
            .config
            .ai_workspace_root
            .to_string_lossy()
            .as_bytes(),
    );
    hash.update(service.config.runtime_root.to_string_lossy().as_bytes());
    hash.update(include_bytes!(
        "../../../../tools/inference/managed-runtime.windows-x64.json"
    ));
    hash.update(include_bytes!(
        "../../../../tools/interrogate/pixai-manifest.json"
    ));
    hex::encode(hash.finalize())
}
fn overrides() -> Vec<&'static str> {
    [
        "AICS_PIXAI_CONFIG",
        "AICS_PIXAI_PYTHON",
        "AICS_PIXAI_MODEL_DIR",
        "AICS_PIXAI_DEPS_DIR",
        "AICS_PIXAI_TORCH_SITE_PACKAGES",
    ]
    .into_iter()
    .filter(|key| std::env::var_os(key).is_some())
    .collect()
}
fn read_receipt(path: &Path) -> Option<Value> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(65537)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
fn same_path(value: &Value, path: &Path) -> bool {
    value.as_str().is_some_and(|value| {
        Path::new(value)
            .canonicalize()
            .ok()
            .zip(path.canonicalize().ok())
            .is_some_and(|(a, b)| a == b)
    })
}
fn runtime_ready(root: &Path, runtime: &RuntimeBundle) -> bool {
    read_receipt(&root.join("runtime-config.json")).is_some_and(|value| {
        value["schemaVersion"] == 1
            && value["engine"] == "native"
            && value["managedRuntimeId"] == runtime.runtime_id
            && value["manifestSha256"] == runtime_manifest_sha256()
            && value["environment"]["cudaAvailable"] == true
            && same_path(&value["root"], root)
            && same_path(&value["python"], &root.join("venv/Scripts/python.exe"))
            && root.join("venv/Scripts/python.exe").is_file()
    })
}
fn expected_paths(service: &ControlService, runtime: &RuntimeBundle, manifest: &Manifest) -> Value {
    expected_paths_from(&service.config, runtime, manifest)
}
async fn get_plan(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    Ok(Json(s.pixai_setup_plan().await?))
}
async fn prepare(
    State(app): State<crate::AppState>,
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Prepare>,
) -> Result<Json<Value>> {
    let admission = app.host.admit_owned()?;
    let interrogate = app
        .interrogate
        .ok_or_else(|| ApiError::new(503, "INTERROGATE_UNAVAILABLE", "反推服务未启用"))?;
    Ok(Json(
        s.start_pixai_preparation(body, interrogate, admission)
            .await?,
    ))
}
impl ControlService {
    async fn pixai_setup_plan(&self) -> Result<Value> {
        let runtime = runtime_bundle()?;
        let manifest = load_manifest()?;
        let files = artifacts()?;
        let model_bytes: u64 = files.iter().map(|file| file.bytes).sum();
        let hardware = hardware::local_hardware().await;
        let mut reasons = plan::runtime_support(
            &hardware,
            &runtime,
            4,
            "至少 4 GiB 显存（反推时需要约 4 GiB 空闲显存）",
        );
        let env = overrides();
        if !env.is_empty() {
            reasons.push(format!("检测到自定义反推环境 {}；请移除这些覆盖并重启绘遇后使用一键准备，或继续使用高级配置", env.join("、")));
        }
        let config = self.config.clone();
        let runtime_copy = runtime.clone();
        let manifest_copy = manifest.clone();
        let (free, runtime_installed, required_runtime, retained_model, model_installed, ready) =
            tokio::task::spawn_blocking(move || {
                let workspace = &config.ai_workspace_root;
                let base = workspace.join("inference");
                let runtime_root = base.join(&runtime_copy.runtime_id);
                let pixai = workspace.join("PixAI");
                let free = plan::safe_workspace(workspace, &config.app_root).and_then(|free| {
                    plan::safe_directory(&runtime_root)?;
                    plan::safe_directory(&pixai)?;
                    Ok(free)
                });
                let installed = runtime_ready(&runtime_root, &runtime_copy);
                let recoverable = plan::recoverable_runtime(&base, &runtime_copy);
                let required = if installed {
                    0
                } else if recoverable > 0 && plan::candidate_ready(&base, &runtime_copy) {
                    64 * 1024 * 1024
                } else {
                    runtime_copy
                        .required_free_bytes
                        .saturating_sub(plan::retained(
                            &base.join(".downloads").join(&runtime_copy.runtime_id),
                            &runtime_copy.files,
                        ))
                        .saturating_sub(recoverable)
                };
                let retained = plan::retained(&pixai, &files);
                let model_installed = files
                    .iter()
                    .filter(|file| file.path.starts_with("model/"))
                    .all(|file| {
                        std::fs::symlink_metadata(pixai.join(&file.path))
                            .is_ok_and(|m| m.is_file() && m.len() == file.bytes)
                    });
                let document = read_receipt(&config.runtime_root.join("pixai/runtime-config.json"));
                let expected = expected_paths_from(&config, &runtime_copy, &manifest_copy);
                let ready = installed
                    && model_installed
                    && document.is_some_and(|value| {
                        value["schemaVersion"] == 1
                            && value["environment"]["cudaAvailable"] == true
                            && value["environment"]["bf16Supported"] == true
                            && ["python", "modelDir", "depsDir", "torchSitePackages"]
                                .iter()
                                .all(|key| value[key] == expected[key])
                            && Path::new(expected["depsDir"].as_str().unwrap())
                                .join("timm/__init__.py")
                                .is_file()
                    });
                (free, installed, required, retained, model_installed, ready)
            })
            .await
            .map_err(|_| ApiError::new(503, "PIXAI_PLAN_FAILED", "反推准备检查未完成"))?;
        let free = match free {
            Ok(bytes) => Some(bytes),
            Err(error) => {
                reasons.push(error.message);
                None
            }
        };
        let runtime_bytes = if runtime_installed {
            0
        } else {
            runtime.download_bytes
        };
        let required = required_runtime
            .saturating_add(model_bytes.saturating_sub(retained_model))
            .saturating_add(128 * 1024 * 1024);
        if free.is_some_and(|free| free < required) {
            reasons.push("AI 工作区剩余空间不足，请释放空间或另选磁盘后重试".into());
        }
        let root = self.config.ai_workspace_root.join("PixAI");
        let paths = expected_paths(self, &runtime, &manifest);
        let mut sources = runtime.sources.as_array().cloned().unwrap_or_default();
        sources.push(json!({"label":"PixAI Tagger v1.0", "url":format!("https://huggingface.co/{}",manifest.repo)}));
        sources.push(json!({"label":"timm 1.0.30", "url":manifest.timm.file.url}));
        Ok(
            json!({"ok":true,"planId":fingerprint(self),"workspacePath":self.config.ai_workspace_root,
            "supported":reasons.is_empty(),"reasons":reasons,"hardware":hardware,
            "freeBytes":free,"requiredBytes":required,"downloadBytes":runtime_bytes + model_bytes,"ready":ready && env.is_empty(),
            "paths":{"runtimeRoot":self.config.ai_workspace_root.join("inference").join(&runtime.runtime_id),
                "modelRoot":paths["modelDir"],"depsRoot":paths["depsDir"],"cacheRoot":root.join("wheels")},
            "runtime":{"id":runtime.runtime_id,"label":"独立 Python 3.11 · PyTorch CUDA 12.8","installed":runtime_installed,
                "downloadBytes":runtime_bytes,"requiredBytes":required_runtime},
            "model":{"id":"pixai-tagger-v1.0","label":"PixAI Tagger v1.0","revision":manifest.revision,
                "installed":model_installed,"downloadBytes":model_bytes},
            "sources":sources,
            "validation":"准备将核对完整 SHA-256、依赖导入和 CUDA/BF16；首次真实反推仍取决于设备及空闲显存"}),
        )
    }
}
fn expected_paths_from(
    config: &crate::config::Config,
    runtime: &RuntimeBundle,
    manifest: &Manifest,
) -> Value {
    let root = config.ai_workspace_root.join("PixAI");
    let runtime_root = config
        .ai_workspace_root
        .join("inference")
        .join(&runtime.runtime_id);
    json!({"python":runtime_root.join("venv/Scripts/python.exe"),"modelDir":root.join("model"),
        "depsDir":root.join("deps").join(format!("timm-{}-{}",manifest.timm.version,&manifest.timm.file.sha256[..16])),
        "torchSitePackages":runtime_root.join("venv/Lib/site-packages")})
}
