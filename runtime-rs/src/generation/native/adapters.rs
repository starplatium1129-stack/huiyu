//! Local native adapter contracts. File readiness never proves model execution.
use super::resources::{self, within};
use super::*;
use std::{path::Path, sync::LazyLock};
const FILES: &[&str] = &[
    "adapter_worker.py",
    "adapter_identity.py",
    "adapter_loading.py",
    "adapter_contract.py",
    "adapter_media.py",
    "adapter_video.py",
    "video_acceleration.py",
    "video_memory.py",
    "wan_motion.py",
    "wan_pipeline.py",
    "wan22-import.json",
    "h3_packed.py",
    "h3_dwd.py",
    "h3_piflow.py",
    "h3_sparse.py",
    "h3_modulation.py",
    "h3_rotary.py",
    "import_h3.py",
    "h3_vae.py",
    "h3_text.py",
    "adapter-models.json",
    "managed-adapter-models.json",
    "worker_lifecycle.py",
    "native_memory.py",
    "native_attention.py",
    "mapped_weights.py",
    "mapped_residency.py",
    "resident_adapters.py",
    "qwen_prefix_cache.py",
    "qwen_manga_int8.py",
    "qwen_manga_euler.py",
    "qwen_manga_vae.py",
    "locked_identity.py",
    "krea_style.py",
    "krea_adapter.py",
    "krea_transport.py",
    "anima_vae.py",
    "moss_adapter.py",
    "moss_pipeline.py",
    "moss_spectrum.py",
    "moss_execution.py",
    "moss_int8.py",
    "moss_text.py",
    "moss_upscale.py",
    "anima_upscale.py",
    "anima_refinement.py",
    "anima_tiling.py",
    "native_upload.py",
    "native_hash.py",
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

fn sd_cpp(model: &Value) -> bool {
    matches!(model["runner"].as_str(), Some("sd-cpp" | "wan-a14b-sd"))
}

pub(crate) fn h3_packed_steps(root: &Path) -> Option<Vec<u64>> {
    let spec = model("minimax-h3")?;
    let pack = &spec["localPack"];
    let marker = resources::file(root, "huiyu-model.json", true)?;
    let meta = marker.metadata().ok()?;
    if meta.len() > 1024 * 1024 {
        return None;
    }
    let prepared_at = meta.modified().ok()?;
    let receipt: Value = serde_json::from_slice(&std::fs::read(marker).ok()?).ok()?;
    if receipt["schemaVersion"] != 1 || receipt["modelId"] != "minimax-h3"
        || receipt["scope"] != "converted-local-weights-sha256"
        || receipt["revision"] != spec["revision"] || receipt["representation"] != pack["format"]
        || receipt["sourceRevision"] != pack["revision"] {
        return None;
    }
    let files = receipt["files"].as_array()?;
    let mut steps = vec![4];
    for asset in pack["files"].as_array()? {
        let name = asset["path"].as_str()?;
        let file = files.iter().find(|row| row["path"] == name);
        if asset["optional"] == true && file.is_none() && !root.join(name).exists() {
            continue;
        }
        let file = file?;
        let meta = resources::file(root, name, true)?.metadata().ok()?;
        if file["sha256"] != asset["sha256"] || file["bytes"] != asset["bytes"]
            || meta.len() != asset["bytes"].as_u64()? || meta.modified().ok()? > prepared_at {
            return None;
        }
        if name == "loras/turbo-8.safetensors" {
            steps.push(8);
        }
    }
    Some(steps)
}

pub(crate) fn h3_accelerator(root: &Path, name: &str) -> bool {
    let verify = || -> Option<bool> {
        let files = model("minimax-h3")?["localPack"]["accelerators"][name].as_array()?;
        let marker = resources::file(root, &format!("accelerators/{name}.receipt"), true)?;
        let meta = marker.metadata().ok()?;
        if meta.len() > 16 * 1024 { return None; }
        let stamp = meta.modified().ok()?;
        let receipt: Value = serde_json::from_slice(&std::fs::read(marker).ok()?).ok()?;
        if receipt["schemaVersion"] != 1 || receipt["modelId"] != "minimax-h3" || receipt["accelerator"] != name
            || receipt["files"].as_array()? != files { return None; }
        for row in files {
            let meta = resources::file(root, row["path"].as_str()?, true)?.metadata().ok()?;
            if meta.len() != row["bytes"].as_u64()? || meta.modified().ok()? > stamp { return None; }
        }
        Some(true)
    };
    verify().unwrap_or(false)
}

pub(crate) fn model_issue(root: &Path, id: &str) -> Option<String> {
    model(id)
        .ok_or_else(|| "该模型尚无原生适配".to_owned())
        .and_then(|model| {
            if sd_cpp(model) {
                return sd_cpp_files(root, model);
            }
            if model["runner"] == "musetalk-native" {
                return pinned_files(root.parent().ok_or("缺少原生模型根目录")?, model);
            }
            if model["runner"] == "longcat-avatar" {
                return super::model_layout::inspect_managed_bundle(root, id, false);
            }
            super::model_layout::inspect_adapter(root, model)?;
            if model["packedManga"] == true {
                super::model_layout::inspect_managed_bundle(root, id, true)?;
            }
            if id == "minimax-h3" && root.join("transformer/comfy.safetensors").is_file()
                && h3_packed_steps(root).is_none() {
                return Err("H3 本地权重与导入凭据不匹配，请在控制室重新准备。".into());
            }
            if model["family"] == "moss-image" {
                if !root
                    .join("transformer/diffusion_pytorch_model.safetensors")
                    .is_file()
                    && !moss_int8_ready(root, &model["mossInt8"], "huiyu-moss-int8.json")
                {
                    return Err("请在控制室继续准备 MOSS 主模型".to_owned());
                }
                if !moss_bf16_ready(root)
                    && !moss_int8_ready(root, &model["mossTextInt8"], "huiyu-moss-text-int8.json")
                {
                    return Err("请在控制室继续准备 MOSS 文本编码器".to_owned());
                }
            }
            Ok(())
        })
        .err()
}

fn sd_cpp_files(root: &Path, model: &Value) -> std::result::Result<(), String> {
    let base = root.parent().ok_or("缺少原生模型根目录")?;
    let runtime = &manifest()["keyframeRuntime"];
    let runner = format!(
        "{}/{}",
        runtime["directory"].as_str().unwrap(),
        model["executable"].as_str().unwrap_or_else(|| runtime["executable"].as_str().unwrap()),
    );
    if resources::file(base, &runner, true).is_none() {
        return Err(format!("缺少原生 CUDA 执行器 {runner}"));
    }
    for name in runtime["serverFiles"].as_object().unwrap().keys() {
        let relative = format!("{}/{}", runtime["directory"].as_str().unwrap(), name);
        if resources::file(base, &relative, true).is_none() {
            return Err(format!("缺少原生 CUDA 执行器组件 {name}"));
        }
    }
    pinned_files(base, model)
}

fn pinned_files(base: &Path, model: &Value) -> std::result::Result<(), String> {
    for id in model["components"].as_object().unwrap().values() {
        let asset = &manifest()["keyframeAssets"][id.as_str().unwrap()];
        let path = asset["path"].as_str().unwrap();
        let size = resources::file(base, path, true)
            .and_then(|file| file.metadata().ok())
            .map(|metadata| metadata.len());
        if size != asset["bytes"].as_u64() {
            return Err(format!("原生权重缺失或长度不符，请准备 {path}"));
        }
    }
    Ok(())
}

fn moss_int8_ready(root: &Path, spec: &Value, marker: &str) -> bool {
    spec["path"].as_str().is_some_and(|file| {
        root.join(marker).is_file()
            && std::fs::metadata(root.join(file))
                .is_ok_and(|info| info.is_file() && spec["bytes"].as_u64() == Some(info.len()))
    })
}

fn moss_bf16_ready(root: &Path) -> bool {
    root.join("text_encoder/model.safetensors.index.json")
        .is_file()
        || root.join("text_encoder/model.safetensors").is_file()
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
    // Anima's Cosmos backend and residency do not configure other model families.
    adapter.acceleration = "native".into();
    adapter.memory_policy = settings.adapter_memory_policy.clone();
    Ok(adapter)
}
pub(crate) fn dedicated_runtime(id: &str) -> bool {
    model(id).is_some_and(|spec| spec["runner"] == "longcat-avatar")
}

pub(crate) fn longcat_python(models_root: &Path) -> PathBuf {
    let fallback = models_root.parent().unwrap_or(models_root)
        .join("environments/longcat-avatar")
        .join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" });
    std::env::var_os("HUIYU_LONGCAT_PYTHON").map(PathBuf::from).unwrap_or(fallback)
}

pub(crate) fn longcat_environment_root(python: &Path) -> &Path {
    let bin = python.parent().unwrap_or(python);
    if bin.ends_with("Scripts") || bin.ends_with("bin") { bin.parent().unwrap_or(bin) } else { bin }
}

pub(crate) fn longcat_environment(python: &Path) -> Result<()> {
    if !python.is_absolute() || !python.is_file() {
        return Err(ApiError::new(503, "NATIVE_ADAPTER_RUNTIME_MISSING",
            format!("请准备 LongCat 专用 Python：{}，或设置 HUIYU_LONGCAT_PYTHON", python.display())));
    }
    let source = std::env::var_os("HUIYU_LONGCAT_SOURCE").map(PathBuf::from)
        .unwrap_or_else(|| longcat_environment_root(python).join("upstream/LongCat-Video"));
    if !source.join("longcat_video/pipeline_longcat_video_avatar.py").is_file() {
        return Err(ApiError::new(503, "NATIVE_ADAPTER_RUNTIME_MISSING",
            format!("请准备固定版本的 LongCat-Video 源码：{}，或设置 HUIYU_LONGCAT_SOURCE", source.display())));
    }
    Ok(())
}

fn model_settings(settings: &Settings, id: &str) -> Result<Settings> {
    if model(id).is_some_and(|spec| sd_cpp(spec) || spec["runner"] == "musetalk-native") {
        let mut local = settings.clone();
        local.adapter_python = super::config::sd_cpp_python(settings);
        let adapter = self::settings(&local)?;
        let required: &[&str] = if model(id).is_some_and(|spec| spec["runner"] == "musetalk-native") {
            &["musetalk_native.py", "musetalk_ink.py"]
        } else if model(id).is_some_and(|spec| spec["runner"] == "wan-a14b-sd") {
            &["keyframe_sd.py", "wan_a14b_sd.py"]
        } else {
            &["keyframe_sd.py", "keyframe_server.py", "wan_a14b_sd.py"]
        };
        if let Some(issue) = resources::worker_bundle_issue(&adapter.worker, required) {
            return Err(ApiError::new(503, "NATIVE_ADAPTER_RUNTIME_MISSING", issue));
        }
        return Ok(adapter);
    }
    if !dedicated_runtime(id) { return self::settings(settings); }
    let python = longcat_python(&settings.models_root);
    longcat_environment(&python)?;
    let mut dedicated = settings.clone();
    dedicated.adapter_python = Some(python);
    let adapter = self::settings(&dedicated)?;
    if let Some(issue) = resources::worker_bundle_issue(&adapter.worker, &["longcat_avatar.py"]) {
        return Err(ApiError::new(503, "NATIVE_ADAPTER_RUNTIME_MISSING", issue));
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
/// One filesystem inspection per status request. Each submission checks again.
pub(crate) struct Status<'a> {
    settings: &'a Settings,
    pub(crate) runtime_error: Option<ApiError>,
}

impl<'a> Status<'a> {
    pub(crate) fn new(settings: &'a Settings) -> Self {
        let runtime_error = self::settings(settings)
            .and_then(|adapter| validate_runtime(&adapter))
            .err();
        Self {
            settings,
            runtime_error,
        }
    }

    fn issue(&self, id: &str, path: &Path) -> Option<String> {
        if dedicated_runtime(id) || model(id).is_some_and(|spec| sd_cpp(spec) || spec["runner"] == "musetalk-native") {
            if let Err(error) = model_settings(self.settings, id).and_then(|adapter| validate_runtime(&adapter)) {
                return Some(error.message);
            }
        } else if let Some(error) = &self.runtime_error {
            return Some(error.message.clone());
        }
        if within(&self.settings.models_root, path).is_none() {
            Some(format!("模型根目录内缺少 {id} 的模型文件夹"))
        } else {
            model_issue(path, id)
        }
    }

    pub(crate) fn image_count(&self) -> usize {
        manifest()["models"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(id, spec)| {
                spec["media"] == "image"
                    && self
                        .issue(id, &self.settings.models_root.join(id))
                        .is_none()
            })
            .count()
    }

    pub(crate) fn model(&self, id: &str) -> Value {
        let settings = self.settings;
        let Some(model) = model(id) else {
            return json!({"id":id,"available":false,"readiness":"unavailable", "validation":"待主力机验证",
            "unavailableReason":manifest()["pendingVideo"][id].as_str().unwrap_or("尚无原生适配")});
        };
        let path = settings.models_root.join(id);
        let issue = self.issue(id, &path);
        let keyframe = model["runner"] == "sd-cpp";
        let mut capabilities = json!({"txt2img":model["media"]=="image" && !keyframe,"img2img":model["edit"],"negative":model["negative"],
        "lora":false,"noLora":true,"characterIdentity":false,"mask":false,"hires":false,"rcas":false,"teaCache":false,"weightSyntax":false,"fixedSampling":model["distilled"]==true,"experimental":true,
        "maxReferenceImages":model["maxReferenceImages"].as_u64().unwrap_or(if model["family"]=="qwen-image"{4}else{0})});
        if keyframe {
            for field in ["minSize", "maxSize", "alignment"] {
                capabilities[field] = model[field].clone();
            }
        }
        if model["runner"] == "wan-a14b-sd" {
            capabilities["firstLastFrame"] = json!(true);
            capabilities["tiledVae"] = json!(true);
            capabilities["resolutions"] = json!([480, 720]);
            capabilities["stepOptions"] = model["stepOptions"].clone();
            capabilities["graphBudgetGiB"] = model["graphBudgetGiB"].clone();
        }
        if model["runner"] == "musetalk-native" {
            capabilities["audioDriven"] = json!(true);
            capabilities["maxAudioFrames"] = model["maxFrames"].clone();
            capabilities["fps"] = model["fps"].clone();
        }
        json!({"id":id,"label":model["label"],"family":model["family"],"available":issue.is_none(),
        "profileId":model["profileId"],"sizes":model["sizes"],
        "readiness":if issue.is_none(){"files-ready"}else{"unavailable"},"unavailableReason":issue,
        "validation":"待主力机验证","generationVerified":false,"performanceVerified":false,
        "repository":model["repository"],"sourceRevision":model["revision"],"license":model["license"],"licenseUrl":model["licenseUrl"],
        "defaults":{"steps":model["steps"],"cfg":model["cfg"],"sampler":model["sampler"].as_str().unwrap_or("euler"),"scheduler":"model-config","teaCache":false},
        "mossAcceleration":model["mossAcceleration"],
        "mossAdaptiveSpectrum":model["mossAdaptiveSpectrum"],
        "mossErSde":model["mossPreview"]["sampler"] == "er-sde",
        "mossSpectrumFlexWindow":model["mossSpectrumFlexWindow"],
        "mossRemacri":model["family"] == "moss-image" && resources::remacri(&settings.models_root).is_some(),
        "mossTextPrecision":model["mossTextPrecision"],
        "mossTextBf16Ready":model["family"] == "moss-image" && moss_bf16_ready(&path),
        "mossCompile":model["mossCompile"],
        "mossFp16Ready":model["family"] == "moss-image" && path.join("transformer/diffusion_pytorch_model.safetensors").is_file(),
        "mossInt8Ready":moss_int8_ready(&path, &model["mossInt8"], "huiyu-moss-int8.json"),
        "mossTextInt8Ready":moss_int8_ready(&path, &model["mossTextInt8"], "huiyu-moss-text-int8.json"),
        "durationFrames":model["durationFrames"],"canvases":model["canvases"],"fps":model["fps"],"audio":model["audio"],
        "capabilities":capabilities,
        "modes":if model["media"]=="video" || keyframe {model["modes"].clone()}else if model["edit"]==true{json!(["text","image"])}else{json!(["text"])}})
    }
}
pub(crate) async fn plan(
    settings: &Settings,
    mut input: Value,
    image: Option<super::InputFile>,
) -> Result<Plan> {
    let id = input["modelId"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("缺少模型 ID"))?;
    let adapter = model_settings(settings, id)?;
    let inspected = adapter.clone();
    let root = adapter.models_root.clone();
    let model_id = id.to_owned();
    let upscale = input["mossUpscaleScale"].is_number();
    let text_auto = input["mossTextPrecision"] == "auto";
    let (path, upscale_model_path, text_precision) = tokio::task::spawn_blocking(move || {
        validate_runtime(&inspected)?;
        if upscale {
            let remacri = resources::remacri(&root).ok_or_else(|| {
                ApiError::new(
                    503,
                    "NATIVE_UPSCALER_UNAVAILABLE",
                    "模型根目录 upscale_models 内缺少 Remacri safetensors 文件",
                )
            })?;
            return Ok((root, Some(remacri), None));
        }
        let path = within(&root, &root.join(&model_id)).ok_or_else(|| {
            ApiError::new(
                503,
                "NATIVE_MODEL_UNAVAILABLE",
                format!("模型根目录内缺少 {model_id} 的模型文件夹"),
            )
        })?;
        if let Some(issue) = model_issue(&path, &model_id) {
            return Err(ApiError::new(503, "NATIVE_MODEL_UNAVAILABLE", issue));
        }
        let text_precision = text_auto.then(|| {
            if model(&model_id).is_some_and(|spec| {
                moss_int8_ready(&path, &spec["mossTextInt8"], "huiyu-moss-text-int8.json")
            }) {
                "int8"
            } else {
                "bf16"
            }
        });
        Ok((path, None, text_precision))
    })
    .await
    .map_err(|_| ApiError::new(503, "NATIVE_MODEL_UNAVAILABLE", "模型目录核验未完成"))??;
    if let Some(precision) = text_precision {
        input["mossTextPrecision"] = json!(precision);
    }
    Ok(Plan {
        input: input.into(),
        settings: adapter,
        model_dir: path,
        mask_model_dir: None,
        upscale_model_path,
        init_image: std::sync::Mutex::new(image),
        last_frame: std::sync::Mutex::new(None),
        driving_media: std::sync::Mutex::new(None),
        reference_images: std::sync::Mutex::new(vec![]),
        mask_image: std::sync::Mutex::new(None),
        pen_lines: std::sync::Mutex::new(None),
        sketch_image: std::sync::Mutex::new(None),
        sketch_model_path: None,
        loras: vec![],
    })
}
