use super::*;

pub(super) fn safe_workspace(workspace: &Path, app: &Path) -> Result<u64> {
    if !workspace.is_absolute() {
        return Err(ApiError::new(
            409,
            "WORKSPACE_REQUIRED",
            "请先选择已存在的 AI 工作区目录",
        ));
    }
    let mut created = false;
    if !workspace.exists() {
        let Some(parent) = workspace.parent().filter(|p| p.is_dir()) else {
            return Err(ApiError::new(
                409,
                "WORKSPACE_REQUIRED",
                "请先选择已存在的 AI 工作区目录",
            ));
        };
        safe_directory(parent)?;
        let parent_real = parent.canonicalize()?;
        if app
            .canonicalize()
            .is_ok_and(|root| parent_real.starts_with(root))
        {
            return Err(ApiError::new(
                409,
                "PROTECTED_ROOT",
                "请选择程序安装目录以外的 AI 工作区",
            ));
        }
        std::fs::create_dir(workspace).map_err(|e| {
            ApiError::new(
                409,
                "AI_DIRECTORY_UNAVAILABLE",
                format!("无法创建默认 AI 工作区目录：{e}"),
            )
        })?;
        created = true;
    } else if !workspace.is_dir() {
        return Err(ApiError::new(
            409,
            "WORKSPACE_REQUIRED",
            "请先选择已存在的 AI 工作区目录",
        ));
    }
    let real = workspace.canonicalize()?;
    if app.canonicalize().is_ok_and(|root| real.starts_with(root)) {
        if created {
            let _ = std::fs::remove_dir(workspace);
        }
        return Err(ApiError::new(
            409,
            "PROTECTED_ROOT",
            "请选择程序安装目录以外的 AI 工作区",
        ));
    }
    if let Err(err) = safe_directory(workspace) {
        if created {
            let _ = std::fs::remove_dir(workspace);
        }
        return Err(err);
    }
    crate::resources::available_space(workspace).map_err(|e| {
        if created {
            let _ = std::fs::remove_dir(workspace);
        }
        ApiError::new(409, &e.code, "无法检查磁盘空间，请选择本机可写磁盘")
    })
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
    let mut warnings = vec!["默认按空闲显存分层加载。内存不足时，可先使用较小画幅。".into()];
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
        reasons.push(format!("已检测到 {}。此一键安装包面向 NVIDIA CUDA。AMD ROCm 和 Intel XPU 可在高级设置中选择已配置的 Anima Python 环境",other_names.join("、")));
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
            return Err(ApiError::invalid("请选择已登记的原生模型"));
        }
        let runtime = image_models::runtime_for(Some(&selected))?;
        let hardware = hardware::local_hardware().await;
        let service = self.clone();
        // Keep local metadata reads off the async request worker.
        // Tracking also keeps shutdown waiting if the requesting page disconnects.
        self.tasks.spawn_blocking(move || {
            use crate::generation::native::adapters;
            let dedicated = adapters::dedicated_runtime(&selected);
            let mut reasons = if dedicated { Vec::new() } else { support(&hardware, &runtime) };
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
            let runtime_python = if dedicated {
                adapters::longcat_python(&root.join("models"))
            } else {
                receipt.as_ref().and_then(|(_, value)| value["python"].as_str()).map(PathBuf::from)
                    .unwrap_or_else(|| root.join(&runtime.runtime_id).join(crate::generation::native::python_relative()))
            };
            let runtime_root = if dedicated {
                adapters::longcat_environment_root(&runtime_python).to_path_buf()
            } else {
                receipt.as_ref().and_then(|(path, _)| path.parent()).map(Path::to_path_buf)
                    .unwrap_or_else(|| root.join(&runtime.runtime_id))
            };
            let configured = service.configured_inference()?;
            let active = service.active_inference()?;
            let video = image_models::is_video(&selected);
            let active_engine = if video { active.video_engine() } else { &active.engine };
            let configured_engine = if video { configured.video_engine() } else { &configured.engine };
            let selected_python = if image_models::is_adapter_runtime(&runtime) { configured.adapter_python.clone() } else { Some(configured.python.clone()) };
            let workspace_matches = (dedicated || selected_python.as_ref() == Some(&runtime_python)) && configured.models_root == root.join("models")
                && service.saved.read().unwrap()["inferenceWorkspacePath"]
                    .as_str()
                    .is_none_or(|path| Path::new(path) == service.config.ai_workspace_root);
            let runtime_ready = if dedicated {
                match adapters::longcat_environment(&runtime_python) {
                    Ok(()) => true,
                    Err(e) => { reasons.push(e.message); false }
                }
            } else { receipt.is_some() };
            let recovery_ready = !dedicated && !runtime_ready && candidate_ready(&root, &runtime);
            let required = if runtime_ready || dedicated { 0 } else if recovery_ready {
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
                let source = installation_source(&model_root, model);
                let installed = source.is_some();
                let local_import = if !installed && (reasons.is_empty() || runtime_ready) {
                    local_adapters::available(&service.config.ai_workspace_root, &model.id)
                } else { None };
                let local_checkpoint = !installed && checkpoint_models::workspace_checkpoint(&service.config.ai_workspace_root, model).is_some();
                let (required, required_with_checkpoint) = if installed { (0, 0) } else if let Some(import) = local_import {
                    (import.required_bytes, import.required_bytes)
                } else { model_space(&root, model) };
                let download_bytes = if installed { 0 } else {
                    local_import.map_or_else(|| model.files.iter().map(|file| file.bytes).sum::<u64>(), |import| import.download_bytes(model))
                };
                let label = if source == Some("local") || local_import.is_some() {
                    adapters::model(&model.id).and_then(|spec| spec["localPack"]["label"].as_str()).unwrap_or(&model.label)
                } else { &model.label };
                json!({"id":model.id,"label":label,"revision":model.revision,"license":model.license,
                    "preparation":if model.conversion_profile.is_some(){"checkpoint-conversion"}else if moss_models::is_moss(model){"moss-checkpoint"}else{"complete-model"},
                    "licenseUrl":model.license_url,"sourceUrl":model.source_url,
                    "checkpointFilename":model.checkpoint_filename,"checkpointOptional":
                        (model.checkpoint_filename.is_some() && !model.requires_local_checkpoint)
                        || local_checkpoint
                        || (model.conversion_profile.is_some() && anima_models::input_root(&model_root, model).join("checkpoint.safetensors").is_file()),
                    "requiresAccess":model.requires_access,"family":if image_models::is_video(&model.id) { "video" } else { crate::generation::native::adapters::model(&model.id).and_then(|spec| spec["family"].as_str()).unwrap_or("anima") },
                    "localVideoImport":local_import.is_some(),"downloadBytes":download_bytes,"requiredBytes":if local_checkpoint { required_with_checkpoint } else { required },
                    "requiredBytesWithCheckpoint":required_with_checkpoint,
                    "installed":installed,"localWeights":source == Some("local"),"path":model_root})
            }).collect();
            let model_ready = model_views.iter().any(|value| value["id"] == selected && value["installed"] == true);
            Ok(
                json!({"ok":true,"selectedModelId":selected,"planId":plan_id(&service.config.ai_workspace_root),"workspacePath":service.config.ai_workspace_root,
                "paths":{"runtimeRoot":runtime_root,"modelsRoot":root.join("models"),
                    "lorasRoot":discovered.loras_root,"cacheRoot":root.join(".downloads"),"tempRoot":root.join(".staging")},
                "warnings":capacity_warnings(&hardware),"hardware":hardware,"supported":reasons.is_empty(),"reasons":reasons,"freeBytes":free,
                "runtime":{"id":if dedicated {"longcat-avatar"} else {&runtime.runtime_id},"label":if dedicated {"LongCat · PyTorch 2.6 · CUDA 12.4 · FlashAttention 2"} else if image_models::is_adapter_runtime(&runtime){"图像与视频 · Python 3.11 · PyTorch 2.9 · CUDA 12.8"}else{"Anima · Python 3.11 · CUDA 12.8"},
                    "downloadBytes":if dedicated {0} else {runtime.download_bytes},"requiredBytes":required,"recoveryReady":recovery_ready,"sources":if dedicated {json!([])} else {json!(runtime.sources)},
                    "installed":runtime_ready,"python":runtime_python},"models":model_views,
                "resources":image_resources::views(&root, &configured, &service.config.app_root)?,
                "activeEngine":active_engine,"configuredEngine":configured_engine,"restartRequired":!active.equivalent(&configured),
                "workspaceMatches":workspace_matches,
                "steps":{"runtime":if runtime_ready{"installed"}else{"not-downloaded"},
                    "model":if model_ready{"verified"}else{"not-downloaded-or-incomplete"},
                    "engine":if reasons.is_empty() && active.equivalent(&configured) && active_engine == "native" && workspace_matches && model_ready && runtime_ready{"enabled"}else{"not-enabled"}},
                "validation":"读取组件与安装记录；文件在下载或导入时校验一次，启用不扫描整库"}),
            )
        })
        .await
        .map_err(|_| ApiError::new(503, "WORKSPACE_CHECK_FAILED", "工作区检查未完成"))?
    }
}
pub(super) fn candidate_ready(root: &Path, runtime: &RuntimeBundle) -> bool {
    let candidate = root.join(".staging").join(&runtime.runtime_id);
    let Ok(target) = crate::file_paths::key(&root.join(&runtime.runtime_id)) else {
        return false;
    };
    let target_matches = |value: &Value| {
        value.as_str().is_some_and(|path| {
            crate::file_paths::key(Path::new(path)).is_ok_and(|actual| actual == target)
        })
    };
    let manifest = image_models::manifest_hash(runtime);
    let read_record = |name| {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(candidate.join(name))
            .ok()?
            .take(65537)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() <= 65536)
            .then(|| {
                serde_json::from_slice::<Value>(
                    bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes),
                )
                .ok()
            })
            .flatten()
    };
    let owner_matches = read_record(".huiyu-candidate.json").is_some_and(|owner| {
        owner["schemaVersion"] == 1
            && owner["runtimeId"] == runtime.runtime_id
            && owner["manifestSha256"] == manifest
            && target_matches(&owner["targetRoot"])
    });
    if !owner_matches {
        return false;
    }
    let requirements: &[u8] = if image_models::is_adapter_runtime(runtime) {
        include_bytes!("../../../../tools/inference/requirements-adapters.txt")
    } else {
        include_bytes!("../../../../tools/inference/requirements.txt")
    };
    let value = read_record("runtime-config.json");
    value.is_some_and(|value| {
        value["schemaVersion"] == 1
            && value["engine"] == "native"
            && value["managedRuntimeId"] == runtime.runtime_id
            && value["manifestSha256"] == manifest
            && value["requirementsSha256"] == hex::encode(Sha256::digest(requirements))
            && value["environment"]["cudaAvailable"] == true
            && target_matches(&value["root"])
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
pub(super) fn model_space(root: &Path, model: &ModelBundle) -> (u64, u64) {
    let target = root.join("models").join(&model.id);
    if let Some(checkpoint) = checkpoint_models::conversion_checkpoint(model) {
        let inputs = anima_models::input_root(&target, model);
        let required = model
            .required_bytes
            .saturating_sub(retained(&inputs, &model.files));
        let extra_checkpoint =
            checkpoint.bytes - retained(&inputs, std::slice::from_ref(checkpoint));
        return (
            required.saturating_add(64 * 1024 * 1024),
            required
                .saturating_sub(extra_checkpoint)
                .saturating_add(64 * 1024 * 1024),
        );
    }
    let stage = root
        .join(".staging")
        .join(format!("{}-{}", model.id, model.revision));
    let required = model
        .required_bytes
        .saturating_sub(retained(
            if target.exists() { &target } else { &stage },
            &image_models::cached_artifacts(root, model),
        ))
        .saturating_add(64 * 1024 * 1024);
    (required, required)
}
