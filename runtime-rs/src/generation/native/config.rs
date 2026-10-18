use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};
use super::resources::{self, within};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub engine: String,
    #[serde(default = "default_acceleration")]
    pub acceleration: String,
    #[serde(default = "default_memory_policy")]
    pub memory_policy: String,
    pub python: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_python: Option<PathBuf>,
    pub worker: PathBuf,
    pub models_root: PathBuf,
    pub loras_root: PathBuf,
    #[serde(skip)]
    pub environment_overrides: Vec<String>,
}
fn default_acceleration() -> String {
    "native".into()
}
fn default_memory_policy() -> String {
    "resident".into()
}
impl Settings {
    /// Installation receipts are hints only. Discover bounded local resources,
    /// without executing Python or changing a user's selected engine/settings.
    pub(crate) fn discovered(workspace: &Path) -> (Self, Option<PathBuf>) {
        let root = workspace.join("inference");
        let worker = bundled_worker();
        let receipt = installed_runtime(&root, &worker);
        let mut models_root = root.join("models");
        if model_count(&models_root) == 0
            && let Some((_, document)) = &receipt
            && let Some(path) = document["modelRoot"].as_str().map(PathBuf::from)
            && within(&root, &path).is_some()
            && model_count(&path) > 0
        {
            models_root = path;
        }
        let native_loras = root.join("loras");
        let shared_loras = workspace.join("ComfyUI/models/loras");
        let loras_root = if lora_count(&native_loras) == 0
            && within(workspace, &shared_loras).is_some()
            && lora_count(&shared_loras) > 0
        {
            shared_loras
        } else {
            native_loras
        };
        let python = receipt
            .as_ref()
            .and_then(|(_, value)| value["python"].as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join(python_relative()));
        let receipt_path = receipt.map(|(path, _)| path);
        (
            Self {
                engine: "comfy".into(),
                acceleration: default_acceleration(),
                memory_policy: default_memory_policy(),
                python,
                adapter_python: None,
                worker,
                models_root,
                loras_root,
                environment_overrides: Vec::new(),
            },
            receipt_path,
        )
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if !matches!(self.engine.as_str(), "comfy" | "native") {
            return Err(ApiError::invalid("推理引擎仅支持 comfy 或 native"));
        }
        if !matches!(
            self.acceleration.as_str(),
            "native" | "sage" | "compiled-sage" | "compiled-fused-sage"
        ) {
            return Err(ApiError::invalid("独立推理加速模式无效"));
        }
        if !matches!(self.memory_policy.as_str(), "resident" | "offload") {
            return Err(ApiError::invalid("独立推理显存策略无效"));
        }
        for path in [
            &self.python,
            &self.worker,
            &self.models_root,
            &self.loras_root,
        ] {
            if !path.is_absolute() || path.to_str().is_none_or(|p| p.contains('\0')) {
                return Err(ApiError::invalid("推理路径必须是有效的绝对路径"));
            }
        }
        if self.adapter_python.as_ref().is_some_and(|p| !p.is_absolute() || p.to_str().is_none_or(|s| s.contains('\0'))) {
            return Err(ApiError::invalid("新增模型 Python 必须是有效的绝对路径"));
        }
        Ok(())
    }
    pub(crate) async fn validate_files(&self) -> Result<()> {
        let settings = self.clone();
        tokio::task::spawn_blocking(move || settings.validate_files_sync()).await
            .map_err(|_| ApiError::new(503, "NATIVE_RUNTIME_UNAVAILABLE", "独立推理运行文件读取未完成"))?
    }
    /// Anima's shipped helpers, without importing Python or checking weights/devices.
    /// Adapter and manga runtimes keep their own explicit bundle declarations.
    pub(crate) async fn validate_anima_files(&self) -> Result<()> {
        let settings = self.clone();
        tokio::task::spawn_blocking(move || {
            settings.validate_files_sync()?;
            if let Some(issue) = resources::worker_bundle_issue(&settings.worker, resources::ANIMA_WORKER_FILES) {
                return Err(ApiError::new(503, "NATIVE_RUNTIME_UNAVAILABLE", issue));
            }
            Ok(())
        }).await.map_err(|_| ApiError::new(503, "NATIVE_RUNTIME_UNAVAILABLE", "独立推理运行文件读取未完成"))?
    }
    pub(crate) fn validate_files_sync(&self) -> Result<()> {
        self.validate()?;
        for path in [&self.python, &self.worker] {
            if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
                return Err(ApiError::new(
                    503,
                    "NATIVE_RUNTIME_UNAVAILABLE",
                    "独立推理 Python 或 worker 未安装",
                ));
            }
        }
        Ok(())
    }
    /// Keep diagnostics and all model workers on the same isolated offline policy.
    /// Installed worker sources are read-only: never write Python bytecode beside them.
    /// The caller owns arguments, I/O, process registration and execution limits.
    pub(crate) fn worker_command(&self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&self.python);
        command.arg("-I").arg("-B").arg("-u").args(["-X", "utf8"]).arg(&self.worker)
            .env_remove("PYTHONPATH").env_remove("PYTHONHOME")
            .env("HUIYU_INFERENCE_ACCELERATION", &self.acceleration)
            .env("HUIYU_INFERENCE_MEMORY", &self.memory_policy)
            .env("HF_HUB_OFFLINE", "1").env("TRANSFORMERS_OFFLINE", "1");
        command
    }
}
/// Snapshot configuration once at service construction. Request paths must use
/// that snapshot, never reread a configuration saved pending application restart.
pub(crate) fn load(config: &Config) -> Result<Settings> {
    let saved = read_optional(&config.runtime_root.join("config.json"))?;
    let mut value = if let Some(inference) = saved.get("inference") {
        let settings: Settings =
            serde_json::from_value(inference.clone()).map_err(|_| config_error())?;
        // Managed setup records its workspace independently of user-selected
        // external paths. A changed workspace must not retain old readiness.
        // Legacy explicit settings have no marker and remain user-owned.
        let moved = saved["inferenceWorkspacePath"].as_str().is_some_and(|workspace| {
            let path = Path::new(workspace);
            path != config.ai_workspace_root.as_path()
                && path.canonicalize().ok().zip(config.ai_workspace_root.canonicalize().ok())
                    .is_none_or(|(saved, current)| saved != current)
        });
        if moved {
            let mut value = serde_json::to_value(Settings::discovered(&config.ai_workspace_root).0)?;
            value["engine"] = json!(settings.engine);
            value
        } else {
            serde_json::to_value(settings)?
        }
    } else {
        serde_json::to_value(Settings::discovered(&config.ai_workspace_root).0)?
    };
    let mut overrides = Vec::new();
    for (key, env) in [
        ("engine", "HUIYU_IMAGE_ENGINE"),
        ("acceleration", "HUIYU_INFERENCE_ACCELERATION"),
        ("memoryPolicy", "HUIYU_INFERENCE_MEMORY"),
        ("python", "HUIYU_INFERENCE_PYTHON"),
        ("adapterPython", "HUIYU_NATIVE_ADAPTER_PYTHON"),
        ("worker", "HUIYU_INFERENCE_WORKER"),
        ("modelsRoot", "HUIYU_INFERENCE_MODELS_ROOT"),
        ("lorasRoot", "HUIYU_INFERENCE_LORAS_ROOT"),
    ] {
        if let Some(raw) = std::env::var_os(env) {
            value[key] = json!(raw.to_str().ok_or_else(config_error)?);
            overrides.push(key.to_owned());
        }
    }
    let mut settings: Settings = serde_json::from_value(value).map_err(|_| config_error())?;
    settings.validate().map_err(|_| config_error())?;
    settings.environment_overrides = overrides;
    Ok(settings)
}

fn bundled_worker() -> PathBuf {
    let installed = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .map(|root| root.join("tools/inference/worker.py"))
        });
    // Packaged machines use only the installed worker. The compile-time source
    // path is a developer convenience, never an installation fallback.
    if std::env::var("AICS_DESKTOP_PACKAGED").as_deref() == Ok("1") {
        return installed.unwrap_or_default();
    }
    installed.filter(|path| path.is_file())
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("tools/inference/worker.py")
        })
}
fn python_relative() -> &'static str {
    if cfg!(windows) {
        "venv/Scripts/python.exe"
    } else {
        "venv/bin/python"
    }
}
impl Settings {
    pub(crate) fn model_count(&self) -> usize {
        model_count(&self.models_root)
    }
    pub(crate) fn lora_count(&self) -> usize {
        lora_count(&self.loras_root)
    }
}
fn model_count(root: &Path) -> usize {
    crate::images::catalog()["MODELS"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(id, model)| {
            model["family"] == "anima"
                && within(root, &root.join(id.as_str()))
                    .is_some_and(|path| super::model_layout::model_issue(&path).is_none())
        })
        .count()
}
fn lora_count(root: &Path) -> usize {
    crate::images::catalog()["LORAS"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(|lora| lora["file"].as_str())
        .filter(|name| resources::file(root, name, false).is_some())
        .count()
}
fn installed_runtime(root: &Path, worker: &Path) -> Option<(PathBuf, Value)> {
    if std::fs::symlink_metadata(root)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let requirements = std::fs::read(worker.parent()?.join("requirements.txt")).ok()?;
    let expected_hash = format!("{:x}", Sha256::digest(requirements));
    let mut candidates = vec![root.to_owned()];
    // Never recurse into virtual environments, model trees or arbitrary disks.
    // An oversized directory falls back to its own receipt, not an arbitrary subset.
    if let Ok(entries) = std::fs::read_dir(root) {
        let entries: Vec<_> = entries.take(129).collect();
        if entries.len() <= 128 {
            let mut folders: Vec<_> = entries
                .into_iter()
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path())
                .collect();
            folders.sort();
            candidates.extend(folders);
        }
    }
    for folder in candidates {
        let path = folder.join("runtime-config.json");
        if within(root, &path).is_none() {
            continue;
        }
        let Some(document) = read_receipt(&path) else {
            continue;
        };
        let Some(python) = document["python"].as_str().map(PathBuf::from) else {
            continue;
        };
        if document["schemaVersion"] != 1
            || document["engine"] != "native"
            || document["requirementsSha256"] != expected_hash
            || document["environment"]["cudaAvailable"] != true
            || !python.is_absolute()
            || !python.is_file()
            || within(&folder, &python).is_none()
            || python.canonicalize().ok() != folder.join(python_relative()).canonicalize().ok()
            || document["root"]
                .as_str()
                .and_then(|root| Path::new(root).canonicalize().ok())
                != folder.canonicalize().ok()
        {
            continue;
        }
        return Some((path, document));
    }
    None
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
fn read_optional(path: &std::path::Path) -> Result<Value> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| config_error()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(_) => Err(config_error()),
    }
}
fn config_error() -> ApiError {
    ApiError::new(
        503,
        "NATIVE_CONFIG_INVALID",
        "独立推理配置无效，请检查引擎及绝对路径",
    )
}
