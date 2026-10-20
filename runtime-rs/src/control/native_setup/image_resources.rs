//! Fixed auxiliary bundles and LoRAs share the owned, resumable preparation job.
use super::*;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Resource {
    id: String, label: String, family: String, description: String,
    license_url: String, source_url: String, directory: String, path: String,
    files: Vec<Artifact>,
}
fn entries() -> Result<Vec<Resource>> {
    let mut loras: Vec<Value> = super::super::setup_verify::model_manifest()?["files"].as_array().unwrap()
        .iter().filter(|value| value["kind"] == "lora").cloned().collect();
    for entry in &mut loras { entry["family"] = json!("anima"); }
    let styles: Value = serde_json::from_str(include_str!("../../../../tools/inference/managed-image-resources.json"))?;
    loras.extend(styles["files"].as_array().unwrap().iter().cloned());
    let auxiliary: Value = serde_json::from_str(include_str!("../../../../tools/inference/managed-auxiliary-models.json"))?;
    let mut entries: Vec<Resource> = serde_json::from_value(auxiliary["resources"].clone())?;
    for entry in loras {
        let path = entry["path"].as_str().and_then(|path| path.strip_prefix("loras/"))
            .ok_or_else(|| ApiError::invalid("原生 LoRA 清单路径无效"))?.to_owned();
        entries.push(Resource { id: entry["id"].as_str().unwrap().into(), label: entry["label"].as_str().unwrap().into(),
            family: entry["family"].as_str().unwrap().into(), directory: "loras".into(), path: path.clone(),
            description: if entry["family"] == "krea2" {"适用于 Krea 2 的官方风格 LoRA。"} else {"适用于对应 Anima 模型的角色 LoRA。"}.into(),
            license_url: entry["licenseUrl"].as_str().unwrap().into(), source_url: entry["sourceUrl"].as_str().unwrap().into(),
            files: vec![Artifact { path, url: entry["sourceUrl"].as_str().unwrap().into(), bytes: entry["bytes"].as_u64().unwrap(),
                sha256: entry["sha256"].as_str().unwrap().into(), git_blob_id: String::new(), lfs: false }] });
    }
    for entry in &entries {
        validate_artifacts(&entry.files)?;
        if entry.files.is_empty() || !["models", "loras"].contains(&entry.directory.as_str())
            || entry.files.iter().any(|file| file.path != entry.path && !file.path.starts_with(&format!("{}/",entry.path))) {
            return Err(ApiError::invalid("原生图像资源清单无效"));
        }
    }
    Ok(entries)
}
fn destination(entry: &Resource, managed: &Path, configured: &crate::generation::native::Settings) -> PathBuf {
    if entry.directory == "models" { configured.models_root.clone() } else { managed.join("loras") }
}
fn missing_bytes(root: &Path, files: &[Artifact]) -> u64 {
    files.iter().filter(|file| !crate::generation::native::resources::file(root, &file.path, true)
        .is_some_and(|path| std::fs::metadata(path).is_ok_and(|meta| meta.len() == file.bytes)))
        .map(|file| file.bytes).sum()
}
fn available_space(root: &Path, app: &Path) -> Result<u64> {
    if !root.is_absolute() || root.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err(ApiError::invalid("请先保存有效的本地模型目录"));
    }
    plan::safe_directory(root)?;
    let ancestor = root.ancestors().find(|path| path.exists()).ok_or_else(|| ApiError::invalid("资源磁盘不可用"))?;
    plan::safe_workspace(ancestor, app)
}
pub(super) fn views(managed: &Path, configured: &crate::generation::native::Settings, app: &Path) -> Result<Vec<Value>> {
    let mut spaces = std::collections::BTreeMap::new();
    Ok(entries()?.iter().map(|entry| {
        let root = destination(entry, managed, configured);
        let (free, error) = spaces.entry(root.clone()).or_insert_with(|| match available_space(&root, app) {
            Ok(bytes) => (Some(bytes), String::new()), Err(error) => (None, error.message),
        });
        let missing = missing_bytes(&root, &entry.files);
        json!({"id":entry.id,"label":entry.label,"family":entry.family,"description":entry.description,
            "directory":entry.directory,"root":root,"licenseUrl":entry.license_url,"sourceUrl":entry.source_url,
            "downloadBytes":entry.files.iter().map(|file| file.bytes).sum::<u64>(),"present":missing == 0,
            "fileCount":entry.files.len(),"requiredBytes":missing.saturating_mul(2).saturating_add(32 * 1024 * 1024),
            "freeBytes":free,"prepareError":error,"path":root.join(&entry.path)})
    }).collect())
}
pub(super) async fn download(Extension(service): Extension<Arc<ControlService>>, Json(body): Json<Request>) -> Result<Json<Value>> {
    check_request(&service, &body)?;
    // Credentials are not accepted or stored by this public-source operation.
    if body.hf_token.is_some() { return Err(ApiError::invalid("此资源下载不接收账户令牌；需要登录的来源请自行下载后放入所示目录")); }
    let entry = entries()?.into_iter().find(|entry| Some(entry.id.as_str()) == body.model_id.as_deref())
        .ok_or_else(|| ApiError::invalid("请选择已登记的辅助模型或 LoRA"))?;
    let permit = service.setup_permit()?;
    let root = destination(&entry, &service.config.ai_workspace_root.join("inference"), &service.configured_inference()?);
    if body.resource_root.as_ref() != Some(&root) { return Err(ApiError::new(409, "RESOURCE_ROOT_CHANGED", "资源目录已改变，请重新读取清单并确认")); }
    let app = service.config.app_root.clone();
    let files = entry.files.clone();
    let target = root.clone();
    service.tasks.spawn_blocking(move || {
        let free = available_space(&target, &app)?;
        let required = missing_bytes(&target, &files).saturating_mul(2).saturating_add(32 * 1024 * 1024);
        if free < required { return Err(ApiError::new(409, "INSUFFICIENT_SPACE", "资源下载和校验空间不足，请释放空间后重试")); }
        Ok::<_, ApiError>(())
    }).await.map_err(|_| ApiError::new(503, "WORKSPACE_CHECK_FAILED", "资源目录检查未完成"))??;
    let mut operation = service.begin_with_id("download-native-resource", &["下载并校验资源", "资源已准备"], body.operation_id.as_deref())?;
    operation["workspacePath"] = json!(body.workspace_path);
    operation["planId"] = json!(body.plan_id);
    operation["modelId"] = json!(entry.id);
    operation["resourceRoot"] = json!(root);
    operation["downloadedBytes"] = json!(0);
    operation["totalBytes"] = json!(entry.files.iter().map(|file| file.bytes).sum::<u64>());
    operation["cancelAllowed"] = json!(true);
    service.publish_operation(operation.clone())?;
    let cancel = service.shutdown.child_token();
    *service.environment_cancel.lock().unwrap() = Some(cancel.clone());
    let returned = operation.clone();
    let owned = service.clone();
    service.tasks.spawn(async move {
        let _permit = permit;
        let work = owned.download_native_files(&root, &entry.files, &operation, &cancel);
        tokio::pin!(work);
        let result = match tokio::time::timeout(Duration::from_secs(4 * 3600), &mut work).await {
            Ok(value) => value,
            Err(_) => {
                cancel.cancel();
                let _ = work.await;
                Err(ApiError::new(504, "NATIVE_SETUP_TIMEOUT", "资源下载超时；已完成文件及续传内容保留"))
            }
        };
        owned.environment_cancel.lock().unwrap().take();
        owned.finish(&operation, result);
    });
    Ok(Json(json!({"ok":true,"operation":returned})))
}
