//! Local native adapter contracts. File readiness never proves model execution.
use super::*;
use std::{path::Path, sync::LazyLock};
use super::resources::{self, within};
const FILES: &[&str] = &[
    "adapter_worker.py", "adapter_contract.py", "adapter_media.py", "adapter_video.py",
    "adapter-models.json", "worker_lifecycle.py", "native_memory.py",
    "resident_adapters.py", "locked_identity.py", "krea_style.py", "moss_adapter.py", "moss_pipeline.py",
];
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
            "请在控制室选择所需图像模型并准备原生运行库，或在高级设置中复用已有独立 Python",
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
pub(super) fn validate_runtime(settings: &Settings) -> Result<()> {
    settings.validate_files_sync()?;
    if let Some(issue) = resources::worker_bundle_issue(&settings.worker, FILES) {
        return Err(ApiError::new(503, "NATIVE_ADAPTER_RUNTIME_MISSING", issue));
    }
    Ok(())
}
pub(crate) fn status(settings: &Settings, id: &str) -> Value {
    let Some(model) = model(id) else {
        return json!({"id":id,"available":false,"readiness":"unavailable", "validation":"待主力机验证",
            "unavailableReason":manifest()["pendingVideo"][id].as_str().unwrap_or("尚无原生适配")});
    };
    let path = settings.models_root.join(id);
    let runtime_issue = self::settings(settings).and_then(|adapter| validate_runtime(&adapter)).err().map(|e| e.message);
    let issue = if runtime_issue.is_some() {
        runtime_issue
    } else if within(&settings.models_root, &path).is_none() {
        Some("模型根目录内缺少完整 Diffusers 目录".to_owned())
    } else {
        model_issue(&path, id)
    };
    json!({"id":id,"label":model["label"],"family":model["family"],"available":issue.is_none(),
        "profileId":model["profileId"],"sizes":model["sizes"],
        "readiness":if issue.is_none(){"files-ready"}else{"unavailable"},"unavailableReason":issue,
        "validation":"待主力机验证","generationVerified":false,"performanceVerified":false,
        "repository":model["repository"],"sourceRevision":model["revision"],"license":model["license"],"licenseUrl":model["licenseUrl"],
        "defaults":{"steps":model["steps"],"cfg":model["cfg"],"sampler":model["sampler"].as_str().unwrap_or("euler"),"scheduler":"model-config","teaCache":false},
        "durationFrames":model["durationFrames"],"canvases":model["canvases"],"fps":model["fps"],"audio":model["audio"],
        "capabilities":{"txt2img":model["media"]=="image","img2img":model["edit"],"negative":model["negative"],
            "lora":false,"noLora":true,"characterIdentity":false,"mask":false,"hires":false,"rcas":false,"teaCache":false,"weightSyntax":false,"fixedSampling":model["distilled"]==true,"experimental":true,
            "maxReferenceImages":if model["family"]=="qwen-image"{4}else{0}},
        "modes":if model["media"]=="video" {json!(["text"])}else if model["edit"]==true{json!(["text","image"])}else{json!(["text"])}})
}
pub(crate) async fn plan(
    settings: &Settings,
    input: Value,
    image: Option<super::InputFile>,
) -> Result<Plan> {
    let id = input["modelId"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("缺少模型 ID"))?;
    let adapter = self::settings(settings)?;
    let inspected = adapter.clone();
    let root = adapter.models_root.clone();
    let model_id = id.to_owned();
    let path = tokio::task::spawn_blocking(move || {
        validate_runtime(&inspected)?;
        let path = within(&root, &root.join(&model_id)).ok_or_else(|| ApiError::new(
            503,
            "NATIVE_MODEL_UNAVAILABLE",
            "需要模型根目录内完整 Diffusers 目录；不会下载或回退 ComfyUI",
        ))?;
        if let Some(issue) = model_issue(&path, &model_id) {
            return Err(ApiError::new(503, "NATIVE_MODEL_UNAVAILABLE", issue));
        }
        Ok(path)
    })
        .await
        .map_err(|_| ApiError::new(503, "NATIVE_MODEL_UNAVAILABLE", "模型目录核验未完成"))??;
    Ok(Plan {
        input: input.into(),
        settings: adapter,
        model_dir: path,
        mask_model_dir: None,
        upscale_model_path: None,
        init_image: std::sync::Mutex::new(image),
        reference_images: std::sync::Mutex::new(vec![]),
        mask_image: std::sync::Mutex::new(None),
        pen_lines: std::sync::Mutex::new(None),
        sketch_image: std::sync::Mutex::new(None),
        sketch_model_path: None,
        loras: vec![],
    })
}
