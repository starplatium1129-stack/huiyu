use super::*;

pub(super) fn safe_workspace(workspace: &Path, app: &Path) -> Result<u64> {
    if !workspace.is_absolute() || !workspace.is_dir() {
        return Err(ApiError::new(
            409,
            "WORKSPACE_REQUIRED",
            "请先选择已存在的 AI 工作区目录",
        ));
    }
    let real = workspace.canonicalize()?;
    if app.canonicalize().is_ok_and(|root| real.starts_with(root)) {
        return Err(ApiError::new(
            409,
            "PROTECTED_ROOT",
            "请选择程序安装目录以外的 AI 工作区",
        ));
    }
    safe_directory(workspace)?;
    crate::resources::available_space(workspace)
        .map_err(|e| ApiError::new(409, &e.code, "无法检查磁盘空间，请选择本机可写磁盘"))
}
pub(super) fn safe_directory(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        // A Windows prefix alone (for example \\?\D:) is not a filesystem
        // entry. Inspect it only after RootDir forms the complete volume root.
        if matches!(part, std::path::Component::Prefix(_)) {
            continue;
        }
        let meta = match std::fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                eprintln!("native setup directory {}: {e}", current.display());
                return Err(ApiError::new(
                    409,
                    "AI_DIRECTORY_UNAVAILABLE",
                    format!(
                        "无法检查 AI 资源目录 {}：{e}；请核对目录和访问权限后重试",
                        current.display()
                    ),
                ));
            }
        };
        let mut linked = meta.file_type().is_symlink();
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            linked |= meta.file_attributes() & 0x400 != 0;
        }
        if linked || !meta.is_dir() {
            return Err(ApiError::new(
                409,
                "UNSAFE_PATH",
                "AI 资源目录包含链接或非目录项，请选择本机普通目录",
            ));
        }
    }
    Ok(())
}
pub(super) fn support(hardware: &Value, runtime: &RuntimeBundle) -> Vec<String> {
    // Managed image setup uses budgeted block/leaf offload. Capacity is a
    // workload recommendation, not proof that a CUDA device cannot run it.
    runtime_support(hardware, runtime, 0, "")
}
fn capacity_warnings(hardware: &Value) -> Vec<String> {
    let mut warnings = vec!["默认启用分层卸载，按空闲显存安排模型；大模型或大画幅仍可能内存不足，可先用 Anima 和较小画幅。".into()];
    if hardware["ramBytes"]
        .as_u64()
        .is_none_or(|bytes| bytes < 32 * 1024 * 1024 * 1024)
    {
        warnings.push(
            "建议 32 GiB 系统内存；较小内存可继续准备，加载、转换或生成可能更慢或内存不足。".into(),
        );
    }
    warnings
}
pub(super) fn runtime_support(
    hardware: &Value,
    runtime: &RuntimeBundle,
    vram_gib: u64,
    vram_label: &str,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if !cfg!(all(windows, target_arch = "x86_64")) {
        reasons.push("应用管理运行库目前支持 Windows x64；ARM、Linux、macOS 未提供此运行包".into());
    }
    if hardware["windowsBuild"]
        .as_u64()
        .is_none_or(|build| build < runtime.minimum_windows_build)
    {
        reasons.push(
            "此运行库需要 Windows 10 22H2（19045）或 Windows 11；请更新 Windows 后再准备".into(),
        );
    }
    let devices = hardware["devices"].as_array().cloned().unwrap_or_default();
    if devices.len() > 1
        || ["CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER"]
            .iter()
            .any(|key| std::env::var(key).is_ok_and(|value| !value.is_empty()))
    {
        reasons.push("此首次准备流程目前要求单张 NVIDIA 显卡且没有 CUDA 设备覆盖；多卡或自定义 CUDA 映射请使用高级运行库配置".into());
    }
    if let Some(device) = devices.first() {
        let driver = device["driverVersion"]
            .as_str()
            .unwrap_or("")
            .split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect::<Vec<_>>();
        let minimum = runtime
            .minimum_nvidia_driver
            .split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect::<Vec<_>>();
        let driver_ok = driver.len() >= 2 && driver[..2] >= minimum[..2];
        let capability = device["computeCapability"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok());
        if !driver_ok {
            reasons.push(format!(
                "检测到 NVIDIA 驱动 {}，此运行包需要 {} 或更新，请更新驱动",
                device["driverVersion"].as_str().unwrap_or("未知"),
                runtime.minimum_nvidia_driver
            ));
        }
        if !capability.is_some_and(|n| (8.0..=12.0).contains(&n)) {
            reasons.push(format!("检测到 CUDA 计算能力 {}，此运行包支持 Ampere 至 Blackwell（8.0–12.0）；无法读取时请检查 NVIDIA 驱动", device["computeCapability"].as_str().unwrap_or("未知")));
        }
        if vram_gib > 0
            && !device["vramBytes"]
                .as_u64()
                .is_some_and(|bytes| bytes >= vram_gib * 1024 * 1024 * 1024 - 256 * 1024 * 1024)
        {
            reasons.push(format!("此功能需要{vram_label}；请核对检测到的显存容量"));
        }
    }
    let other_names = hardware["otherDevices"]
        .as_array()
        .map(|devices| {
            devices
                .iter()
                .filter_map(|device| device["name"].as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if devices.is_empty()
        && !other_names.is_empty()
        && !other_names
            .iter()
            .any(|name| name.to_ascii_lowercase().contains("nvidia"))
    {
        reasons.push(format!("已检测到 {}。此原生运行库支持 NVIDIA CUDA，尚未提供 AMD、Intel 或 CPU 推理；当前显卡不能运行此包",other_names.join("、")));
    } else if devices.is_empty() {
        reasons.push("未能通过 nvidia-smi 读取 NVIDIA 设备；请检查驱动和 nvidia-smi 是否可用，再刷新。此状态不代表显卡性能不足".into());
    }
    reasons
}
impl ControlService {
    pub(super) async fn native_setup_plan(
        self: &Arc<Self>,
        selected: Option<&str>,
    ) -> Result<Value> {
        let (_, models) = bundles()?;
        let selected = selected.unwrap_or(&models[0].id).to_owned();
        if !models.iter().any(|model| model.id == selected) {
            return Err(ApiError::invalid("请选择已登记的原生图像模型"));
        }
        let runtime = image_models::runtime_for(Some(&selected))?;
        let hardware = hardware::local_hardware().await;
        let service = self.clone();
        // Keep local metadata reads off the async request worker.
        // Tracking also keeps shutdown waiting if the requesting page disconnects.
        self.tasks.spawn_blocking(move || {
            let mut reasons = support(&hardware, &runtime);
            let space = safe_workspace(&service.config.ai_workspace_root, &service.config.app_root);
            let free = match space {
                Ok(bytes) => Some(bytes),
                Err(e) => {
                    reasons.push(e.message);
                    None
                }
            };
            let root = service.config.ai_workspace_root.join("inference");
            let (discovered, _) = crate::generation::native::Settings::discovered(&service.config.ai_workspace_root);
            let receipt = image_models::runtime_receipt(&service, &runtime);
            let runtime_python = receipt.as_ref().and_then(|(_, value)| value["python"].as_str()).map(PathBuf::from)
                .unwrap_or_else(|| root.join(&runtime.runtime_id).join("venv/Scripts/python.exe"));
            let configured = service.configured_inference()?;
            let active = service.active_inference()?;
            let selected_python = if image_models::is_adapter_runtime(&runtime) { configured.adapter_python.clone() } else { Some(configured.python.clone()) };
            let workspace_matches = selected_python.as_ref() == Some(&runtime_python) && configured.models_root == root.join("models")
                && service.saved.read().unwrap()["inferenceWorkspacePath"]
                    .as_str()
                    .is_none_or(|path| Path::new(path) == service.config.ai_workspace_root);
            let runtime_ready = receipt.is_some();
            let recovery_ready = !runtime_ready && candidate_ready(&root, &runtime);
            let required = if runtime_ready { 0 } else if recovery_ready {
                64 * 1024 * 1024
            } else {
                runtime
                    .required_free_bytes
                    .saturating_sub(retained(
                        &root.join(".downloads").join(&runtime.runtime_id),
                        &runtime.files,
                    ))
            };
            let model_views: Vec<_> = models.iter().map(|model| {
                let model_root = root.join("models").join(&model.id);
                let installed = receipt_matches(&model_root, model);
                json!({"id":model.id,"label":model.label,"revision":model.revision,"license":model.license,
                    "preparation":if model.conversion_profile.is_some(){"checkpoint-conversion"}else{"complete-model"},
                    "licenseUrl":model.license_url,"sourceUrl":model.source_url,
                    "checkpointFilename":model.checkpoint_filename,"checkpointOptional":model.conversion_profile.as_deref()==Some("anima-cosmos2b-v041"),
                    "requiresAccess":model.requires_access,"family":if model.id.starts_with("krea2-"){"krea2"}else if model.id.starts_with("qwen-"){"qwen-image"}else if model.id.starts_with("moss-"){"moss-image"}else{"anima"},
                    "downloadBytes":model.files.iter().map(|file|file.bytes).sum::<u64>(),"requiredBytes":if installed {0}else{model_needed(&root, model)},
                    "installed":installed,"path":model_root})
            }).collect();
            let model_ready = model_views.iter().any(|value| value["id"] == selected && value["installed"] == true);
            Ok(
                json!({"ok":true,"selectedModelId":selected,"planId":plan_id(&service.config.ai_workspace_root),"workspacePath":service.config.ai_workspace_root,
                "paths":{"runtimeRoot":receipt.as_ref().and_then(|(path, _)|path.parent()).map(Path::to_path_buf).unwrap_or_else(||root.join(&runtime.runtime_id)),"modelsRoot":root.join("models"),
                    "lorasRoot":discovered.loras_root,"cacheRoot":root.join(".downloads"),"tempRoot":root.join(".staging")},
                "warnings":capacity_warnings(&hardware),"hardware":hardware,"supported":reasons.is_empty(),"reasons":reasons,"freeBytes":free,
                "runtime":{"id":runtime.runtime_id,"label":if image_models::is_adapter_runtime(&runtime){"原生图像 · Python 3.11 · PyTorch 2.9 · CUDA 12.8"}else{"Anima · Python 3.11 · CUDA 12.8"},
                    "downloadBytes":runtime.download_bytes,"requiredBytes":required,"recoveryReady":recovery_ready,"sources":runtime.sources,
                    "installed":runtime_ready,"python":runtime_python},"models":model_views,
                "resources":image_resources::views(&root, &configured, &service.config.app_root)?,
                "activeEngine":active.engine,"configuredEngine":configured.engine,"restartRequired":active != &configured,
                "workspaceMatches":workspace_matches,
                "steps":{"runtime":if runtime_ready{"installed"}else{"not-downloaded"},
                    "model":if model_ready{"verified"}else{"not-downloaded-or-incomplete"},
                    "engine":if reasons.is_empty() && active == &configured && active.engine == "native" && workspace_matches && model_ready && runtime_ready{"enabled"}else{"not-enabled"}},
                "validation":"读取组件与安装记录；文件在下载或导入时校验一次，启用不扫描整库"}),
            )
        })
        .await
        .map_err(|_| ApiError::new(503, "WORKSPACE_CHECK_FAILED", "工作区检查未完成"))?
    }
}
pub(super) fn candidate_ready(root: &Path, runtime: &RuntimeBundle) -> bool {
    let candidate = root.join(".staging").join(&runtime.runtime_id);
    let value = std::fs::read(candidate.join("runtime-config.json"))
        .ok()
        .filter(|bytes| bytes.len() < 65536)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    value.is_some_and(|value| {
        value["schemaVersion"] == 1
            && value["engine"] == "native"
            && value["managedRuntimeId"] == runtime.runtime_id
            && value["manifestSha256"] == image_models::manifest_hash(runtime)
            && value["environment"]["cudaAvailable"] == true
            && value["root"]
                .as_str()
                .is_some_and(|path| Path::new(path) == root.join(&runtime.runtime_id))
            && candidate.join("venv/Scripts/python.exe").is_file()
    })
}
pub(super) fn retained(root: &Path, files: &[Artifact]) -> u64 {
    files
        .iter()
        .map(|file| {
            let path = root.join(&file.path);
            let complete = std::fs::symlink_metadata(&path)
                .ok()
                .filter(|meta| meta.is_file() && meta.len() == file.bytes)
                .map(|meta| meta.len());
            complete.unwrap_or_else(|| {
                std::fs::symlink_metadata(
                    path.parent()
                        .unwrap()
                        .join(format!(".huiyu-{}.part", file.sha256)),
                )
                .ok()
                .filter(|meta| meta.is_file())
                .map(|meta| meta.len().min(file.bytes))
                .unwrap_or(0)
            })
        })
        .sum()
}
pub(super) fn model_needed(root: &Path, model: &ModelBundle) -> u64 {
    let target = root.join("models").join(&model.id);
    if model.conversion_profile.is_some() {
        return model
            .required_bytes
            .saturating_sub(retained(
                &anima_models::input_root(&target, model),
                &model.files,
            ))
            .saturating_add(64 * 1024 * 1024);
    }
    let stage = root
        .join(".staging")
        .join(format!("{}-{}", model.id, model.revision));
    model
        .required_bytes
        .saturating_sub(retained(
            if target.exists() { &target } else { &stage },
            &image_models::cached_artifacts(root, model),
        ))
        .saturating_add(64 * 1024 * 1024)
}
