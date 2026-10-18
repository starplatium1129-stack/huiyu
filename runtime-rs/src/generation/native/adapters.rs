//! Local native adapter contracts. File readiness never proves model execution.
use super::*;
use std::{path::Path, sync::LazyLock};
static MANIFEST: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../tools/inference/adapter-models.json"
    ))
    .expect("bundled native adapter manifest")
});
pub(crate) fn manifest() -> &'static Value {
    &MANIFEST
}
pub(crate) fn model(id: &str) -> Option<&'static Value> {
    MANIFEST["models"].get(id)
}
pub(crate) fn model_issue(root: &Path, id: &str) -> Option<String> {
    model(id)
        .ok_or_else(|| "该模型尚无原生适配".to_owned())
        .and_then(|model| super::model_layout::inspect_adapter(root, model))
        .err()
}
pub(crate) fn settings(settings: &Settings) -> Result<Settings> {
    let mut adapter = settings.clone();
    adapter.python = settings.adapter_python.clone().ok_or_else(|| {
        ApiError::new(
            503,
            "NATIVE_ADAPTER_RUNTIME_MISSING",
            "新增模型需要独立 Python 环境：设置 HUIYU_NATIVE_ADAPTER_PYTHON；不要升级 Anima 运行库",
        )
    })?;
    adapter.worker = settings.worker.with_file_name("adapter_worker.py");
    if settings.acceleration != "native" {
        return Err(ApiError::new(
            501,
            "NATIVE_FEATURE_UNSUPPORTED",
            "新增模型尚未接入 Anima 的 Sage/编译加速，请选择 native 加速模式",
        ));
    }
    Ok(adapter)
}
pub(crate) fn status(settings: &Settings, id: &str) -> Value {
    let Some(model) = model(id) else {
        return json!({"id":id,"available":false,"readiness":"unavailable", "validation":"待主力机验证",
            "unavailableReason":manifest()["pendingVideo"][id].as_str().unwrap_or("尚无原生适配")});
    };
    let path = settings.models_root.join(id);
    let issue = if settings
        .adapter_python
        .as_ref()
        .is_none_or(|p| !p.is_file())
    {
        Some("新增模型独立 Python 未配置或不存在（HUIYU_NATIVE_ADAPTER_PYTHON）".to_owned())
    } else if !settings
        .worker
        .with_file_name("adapter_worker.py")
        .is_file()
    {
        Some("缺少随包 adapter_worker.py".to_owned())
    } else if settings.acceleration != "native" {
        Some("新增模型仅支持 native 加速模式".to_owned())
    } else if !contained(&settings.models_root, &path) {
        Some("模型根目录内缺少完整 Diffusers 目录".to_owned())
    } else {
        model_issue(&path, id)
    };
    json!({"id":id,"label":model["label"],"family":model["family"],"available":issue.is_none(),
        "readiness":if issue.is_none(){"files-ready"}else{"unavailable"},"unavailableReason":issue,
        "validation":"待主力机验证","generationVerified":false,"performanceVerified":false,
        "repository":model["repository"],"sourceRevision":model["revision"],"license":model["license"],"licenseUrl":model["licenseUrl"],
        "defaults":{"steps":model["steps"],"cfg":model["cfg"],"sampler":model["sampler"].as_str().unwrap_or("euler"),"scheduler":"model-config","teaCache":false},
        "durationFrames":model["durationFrames"],"canvases":model["canvases"],"fps":model["fps"],"audio":model["audio"],
        "capabilities":{"txt2img":model["media"]=="image","img2img":model["edit"],"negative":model["negative"],
            "lora":false,"noLora":true,"mask":false,"hires":false,"rcas":false,"teaCache":false,"weightSyntax":false,"experimental":true},
        "modes":if model["media"]=="video" {json!(["text"])}else if model["edit"]==true{json!(["text","image"])}else{json!(["text"])}})
}
fn contained(root: &Path, path: &Path) -> bool {
    root.canonicalize()
        .ok()
        .zip(path.canonicalize().ok())
        .is_some_and(|(root, path)| path != root && path.starts_with(root))
}
pub(crate) async fn plan(
    settings: &Settings,
    input: Value,
    image: Option<Arc<Vec<u8>>>,
) -> Result<Plan> {
    let id = input["modelId"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("缺少模型 ID"))?;
    let adapter = self::settings(settings)?;
    adapter.validate_files().await?;
    let path = adapter.models_root.join(id);
    if !contained(&adapter.models_root, &path) {
        return Err(ApiError::new(
            503,
            "NATIVE_MODEL_UNAVAILABLE",
            "需要模型根目录内完整 Diffusers 目录；不会下载或回退 ComfyUI",
        ));
    }
    let inspect = path.clone();
    let model_id = id.to_owned();
    if let Some(issue) = tokio::task::spawn_blocking(move || model_issue(&inspect, &model_id))
        .await
        .map_err(|_| ApiError::new(503, "NATIVE_MODEL_UNAVAILABLE", "模型目录核验未完成"))?
    {
        return Err(ApiError::new(503, "NATIVE_MODEL_UNAVAILABLE", issue));
    }
    Ok(Plan {
        input,
        settings: adapter,
        model_dir: path,
        mask_model_dir: None,
        upscale_model_path: None,
        init_image: std::sync::Mutex::new(image),
        mask_image: std::sync::Mutex::new(None),
        pen_lines: std::sync::Mutex::new(None),
        loras: vec![],
    })
}
