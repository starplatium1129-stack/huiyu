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
    let probe = tempfile::NamedTempFile::new_in(workspace).map_err(|_| {
        ApiError::new(
            409,
            "WORKSPACE_NOT_WRITABLE",
            "AI 工作区不可写，请选择有写入权限的目录",
        )
    })?;
    drop(probe);
    crate::resources::available_space(workspace)
        .map_err(|e| ApiError::new(409, &e.code, "无法检查磁盘空间，请选择本机可写磁盘"))
}
pub(super) fn safe_directory(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        let meta = match std::fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
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
    let compatible = devices.first().is_some_and(|device| {
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
        driver_ok
            && capability.is_some_and(|n| (8.0..=12.0).contains(&n))
            && device["vramBytes"]
                .as_u64()
                .is_some_and(|bytes| bytes >= 12 * 1024 * 1024 * 1024 - 256 * 1024 * 1024)
    });
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
    } else if !compatible {
        reasons.push(format!("需要 NVIDIA Ampere 至 Blackwell（计算能力 8.0–12.0）、12 GB 或更多显存及 Windows 驱动 {} 或更新；请从 NVIDIA 更新驱动，绘遇不会安装或修改驱动。未检测到设备时也请检查驱动中的 nvidia-smi。AMD、Intel、旧架构及较小显存尚不支持此运行包",runtime.minimum_nvidia_driver));
    }
    if hardware["ramBytes"]
        .as_u64()
        .is_none_or(|bytes| bytes < 24 * 1024 * 1024 * 1024)
    {
        reasons.push(
            "分阶段加载至少需要 24 GiB 系统内存，建议 32 GiB；显存和复杂画面的实际效果仍需设备验收"
                .into(),
        );
    }
    reasons
}
impl ControlService {
    pub(super) async fn native_setup_plan(&self) -> Result<Value> {
        let (runtime, models) = bundles()?;
        let network = match reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(4))
            .build()
        {
            Ok(client) => {
                let (python, model) = tokio::join!(
                    client.head(&runtime.files[0].url).send(),
                    client.head(&models[0].files[0].url).send()
                );
                let accessible =
                    |result: std::result::Result<reqwest::Response, reqwest::Error>| {
                        result.is_ok_and(|response| response.status().is_success())
                    };
                let runtime_source = accessible(python);
                let model_source = accessible(model);
                json!({"runtimeSource":runtime_source,"modelSource":model_source,
                    "message":if runtime_source && model_source {"固定下载来源可连接；文件下载仍会重新校验"} else {"部分固定来源暂不可连接，请检查网络后重试；已有完整缓存可离线继续。受限或要求登录的来源不会绕过授权"}})
            }
            Err(_) => {
                json!({"runtimeSource":false,"modelSource":false,"message":"网络检查未完成，请检查连接后重试"})
            }
        };
        let hardware = hardware::local_hardware().await;
        let mut reasons = support(&hardware, &runtime);
        let workspace = self.config.ai_workspace_root.clone();
        let app = self.config.app_root.clone();
        let space = tokio::task::spawn_blocking(move || safe_workspace(&workspace, &app))
            .await
            .map_err(|_| ApiError::new(503, "WORKSPACE_CHECK_FAILED", "工作区检查未完成"))?;
        let free = match space {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                reasons.push(e.message);
                None
            }
        };
        let root = self.config.ai_workspace_root.join("inference");
        let (discovered, receipt) =
            crate::generation::native::Settings::discovered(&self.config.ai_workspace_root);
        let configured = self.configured_inference()?;
        let active = self.active_inference()?;
        let workspace_matches = [configured.python.clone(), configured.models_root.clone()]
            .iter()
            .all(|path| path.starts_with(&root))
            && self.saved.read().unwrap()["inferenceWorkspacePath"]
                .as_str()
                .is_none_or(|path| Path::new(path) == self.config.ai_workspace_root);
        let runtime_ready = receipt.is_some();
        let recoverable = recoverable_runtime(&root, &runtime);
        let recovery_ready = recoverable > 0 && candidate_ready(&root, &runtime);
        let required = if recovery_ready {
            64 * 1024 * 1024
        } else {
            runtime
                .required_free_bytes
                .saturating_sub(retained(
                    &root.join(".downloads").join(&runtime.runtime_id),
                    &runtime.files,
                ))
                .saturating_sub(recoverable)
        };
        let model_views: Vec<_> = models.iter().map(|model| {
            let model_root = root.join("models").join(&model.id);
            json!({"id":model.id,"label":model.label,"revision":model.revision,"license":model.license,
                "licenseUrl":model.license_url,"sourceUrl":model.source_url,
                "downloadBytes":model.files.iter().map(|file|file.bytes).sum::<u64>(),"requiredBytes":model_needed(&root, model),
                "installed":receipt_matches(&model_root, model),"path":model_root})
        }).collect();
        let model_ready = model_views.iter().any(|value| value["installed"] == true);
        Ok(
            json!({"ok":true,"planId":plan_id(&self.config.ai_workspace_root),"workspacePath":self.config.ai_workspace_root,
            "paths":{"runtimeRoot":receipt.as_ref().and_then(|path|path.parent()).map(Path::to_path_buf).unwrap_or_else(||root.join(&runtime.runtime_id)),"modelsRoot":root.join("models"),
                "lorasRoot":discovered.loras_root,"cacheRoot":root.join(".downloads"),"tempRoot":root.join(".staging")},
            "hardware":hardware,"network":network,"supported":reasons.is_empty(),"reasons":reasons,"freeBytes":free,
            "runtime":{"id":runtime.runtime_id,"label":"CPython 3.11.9 · PyTorch 2.8.0 CUDA 12.8",
                "downloadBytes":runtime.download_bytes,"requiredBytes":required,"recoverableBytes":recoverable,"recoveryReady":recovery_ready,"sources":runtime.sources,
                "installed":runtime_ready,"python":discovered.python},"models":model_views,
            "activeEngine":active.engine,"configuredEngine":configured.engine,"restartRequired":active != configured,
            "workspaceMatches":workspace_matches,
            "steps":{"runtime":if runtime_ready{"installed"}else{"not-downloaded"},
                "model":if model_ready{"verified"}else{"not-downloaded-or-incomplete"},
                "engine":if reasons.is_empty() && active == configured && active.engine == "native" && workspace_matches && model_ready && runtime_ready{"enabled"}else{"not-enabled"}},
            "validation":"组件和安装记录检查；启用前会重新核对完整 SHA-256 与依赖，真实生成仍需验收"}),
        )
    }
}
fn recoverable_runtime(root: &Path, runtime: &RuntimeBundle) -> u64 {
    let candidate = root.join(".staging").join(&runtime.runtime_id);
    if safe_directory(&candidate).is_err()
        || candidate.join("runtime-config.json").exists() && !candidate_ready(root, runtime)
    {
        return 0;
    }
    let owner = std::fs::read(candidate.join(".huiyu-candidate.json"))
        .ok()
        .filter(|bytes| bytes.len() < 65536)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok());
    let Some(owner) = owner else {
        return 0;
    };
    let hash = hex::encode(Sha256::digest(include_bytes!(
        "../../../../tools/inference/managed-runtime.windows-x64.json"
    )));
    if owner["schemaVersion"] != 1
        || owner["runtimeId"] != runtime.runtime_id
        || owner["manifestSha256"] != hash
        || !owner["targetRoot"]
            .as_str()
            .is_some_and(|path| Path::new(path) == root.join(&runtime.runtime_id))
    {
        return 0;
    }
    let mut folders = vec![candidate];
    let mut bytes = 0u64;
    let mut count = 0usize;
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(folder) else {
            return 0;
        };
        for entry in entries {
            count += 1;
            if count > 100000 {
                return 0;
            }
            let Ok(entry) = entry else {
                return 0;
            };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                return 0;
            };
            if meta.file_type().is_symlink() {
                return 0;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return 0;
                }
            }
            if meta.is_dir() {
                folders.push(entry.path());
            } else if meta.is_file()
                && crate::file_identity::path(&entry.path(), false)
                    .is_ok_and(|identity| identity.links == 1)
            {
                bytes = bytes.saturating_add(meta.len());
            } else {
                return 0;
            }
        }
    }
    bytes
}
fn candidate_ready(root: &Path, runtime: &RuntimeBundle) -> bool {
    let candidate = root.join(".staging").join(&runtime.runtime_id);
    let value = std::fs::read(candidate.join("runtime-config.json"))
        .ok()
        .filter(|bytes| bytes.len() < 65536)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let hash = hex::encode(Sha256::digest(include_bytes!(
        "../../../../tools/inference/managed-runtime.windows-x64.json"
    )));
    value.is_some_and(|value| {
        value["schemaVersion"] == 1
            && value["engine"] == "native"
            && value["managedRuntimeId"] == runtime.runtime_id
            && value["manifestSha256"] == hash
            && value["environment"]["cudaAvailable"] == true
            && value["root"]
                .as_str()
                .is_some_and(|path| Path::new(path) == root.join(&runtime.runtime_id))
            && candidate.join("venv/Scripts/python.exe").is_file()
    })
}
fn retained(root: &Path, files: &[Artifact]) -> u64 {
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
    let stage = root
        .join(".staging")
        .join(format!("{}-{}", model.id, model.revision));
    model
        .required_bytes
        .saturating_sub(retained(
            if target.exists() { &target } else { &stage },
            &model.files,
        ))
        .saturating_add(64 * 1024 * 1024)
}
