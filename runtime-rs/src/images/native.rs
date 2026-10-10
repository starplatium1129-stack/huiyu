use super::*;
use generation::native::{Plan, Settings};

const CLIPSEG_FOLDER: &str = "clipseg-rd64-refined";
const CLIPSEG_FILES: [&str; 7] = [
    "config.json",
    "preprocessor_config.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
    "model.safetensors",
];
const TEACACHE_PROFILE: &str = "teacache-profile.json";

pub(super) fn normalize(raw: &Value, mut input: Value) -> Result<Value> {
    if input["family"] != "anima" {
        return Err(ApiError::new(
            501,
            "NATIVE_FAMILY_UNSUPPORTED",
            "独立推理当前仅支持 Anima",
        ));
    }
    if input["cfg"].as_f64().is_some_and(|cfg| cfg < 1.) {
        return Err(error("INVALID_PARAMETER", "独立推理 CFG 必须至少为 1"));
    }
    // Defaults belong to the selected provider. Explicit unsupported requests
    // are never silently converted into a different operation.
    for key in ["hiresFix", "styleLoraId", "rcas", "faceDetailer"] {
        if generation::truthy(&raw[key]) {
            return Err(ApiError::new(
                501,
                "NATIVE_FEATURE_UNSUPPORTED",
                format!("独立推理尚不支持 {key}"),
            ));
        }
    }
    if generation::truthy(&raw["maskImage"])
        && !input["maskImage"]
            .as_str()
            .is_some_and(|name| !name.is_empty())
    {
        return Err(error("INVALID_PARAMETER", "手绘遮罩必须是已上传的图像名称"));
    }
    let manual = input["maskImage"]
        .as_str()
        .is_some_and(|name| !name.is_empty());
    let automatic = input["maskPrompt"]
        .as_str()
        .filter(|prompt| !prompt.trim().is_empty());
    if generation::truthy(&raw["maskPrompt"]) && automatic.is_none() {
        return Err(error("INVALID_PARAMETER", "自动遮罩需要非空识别词"));
    }
    if manual && automatic.is_some() {
        return Err(error("INVALID_PARAMETER", "手绘遮罩与自动识别不能同时提交"));
    }
    if let Some(prompt) = automatic {
        let phrases: std::collections::HashSet<_> = prompt
            .split('|')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if prompt.chars().count() > 4096 || phrases.is_empty() || phrases.len() > 32 {
            return Err(error(
                "INVALID_PARAMETER",
                "自动识别词最多 4096 字符、32 个以 | 分隔的区域词",
            ));
        }
        validation::number(&input["maskThreshold"], "maskThreshold", 0.05, 0.95, false)?;
    }
    if manual || automatic.is_some() {
        if !input["initImage"]
            .as_str()
            .is_some_and(|name| !name.is_empty())
        {
            return Err(error("INVALID_PARAMETER", "局部遮罩重绘必须同时提供原图"));
        }
        validation::number(&input["growMaskBy"], "growMaskBy", 0., 32., true)?;
    }
    for key in ["sampler", "scheduler"] {
        let expected = if key == "sampler" { "euler" } else { "simple" };
        if raw.get(key).is_some_and(|value| value != expected) {
            return Err(ApiError::new(
                501,
                "NATIVE_FEATURE_UNSUPPORTED",
                format!("独立推理仅支持 {key}={expected}"),
            ));
        }
        input[key] = json!(expected);
    }
    let tea_cache = match raw.get("teaCache") {
        None => false,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => return Err(error("INVALID_PARAMETER", "独立推理 teaCache 必须为布尔值")),
    };
    input["teaCache"] = json!(tea_cache);
    // Shared validation supplies Comfy defaults. Native calibration owns its
    // threshold instead, unless this request explicitly chose a numeric value.
    input.as_object_mut().unwrap().remove("teaCacheThresh");
    if let Some(threshold) = raw.get("teaCacheThresh") {
        if !tea_cache {
            return Err(error(
                "INVALID_PARAMETER",
                "TeaCache 已关闭，请移除原生请求中的 teaCacheThresh",
            ));
        }
        input["teaCacheThresh"] = validation::number(threshold, "teaCacheThresh", 0.01, 1., false)?;
    }
    input["inferenceEngine"] = json!("native");
    Ok(input)
}
pub(super) async fn plan(
    settings: &Settings,
    input: Value,
    originals: &[inputs::Original],
) -> Result<Plan> {
    if input["inferenceEngine"] != "native"
        || input["family"] != "anima"
        || input["sampler"] != "euler"
        || input["scheduler"] != "simple"
    {
        return Err(ApiError::new(
            409,
            "TASK_RESUME_UNSAFE",
            "独立推理参数与当前能力不匹配",
        ));
    }
    normalize(&input, input.clone())?;
    settings.validate_files().await?;
    let id = input["modelId"]
        .as_str()
        .ok_or_else(|| error("UNKNOWN_MODEL", "未知生成模型"))?;
    catalog::model(id)?;
    let model_dir = contained(&settings.models_root, id).await.ok_or_else(|| {
        ApiError::new(
            503,
            "NATIVE_MODEL_UNAVAILABLE",
            "独立推理需要完整本地 Diffusers 模型目录",
        )
    })?;
    if !model_available(&model_dir).await {
        return Err(ApiError::new(
            503,
            "NATIVE_MODEL_UNAVAILABLE",
            "独立推理需要完整本地 Diffusers 模型目录",
        ));
    }
    let tea_cache_profile_path = if input["teaCache"] == true {
        Some(tea_cache_profile(&model_dir).await.ok_or_else(|| ApiError::new(503,
            "NATIVE_TEACACHE_PROFILE_UNAVAILABLE", "TeaCache 需要所选模型目录内的本地 teacache-profile.json 校准档；缺失、空文件或越界路径不会回退为无缓存生成"))?)
    } else {
        None
    };
    let mask_model_dir = if input["maskPrompt"]
        .as_str()
        .is_some_and(|prompt| !prompt.is_empty())
    {
        Some(clipseg_model_dir(settings).await.ok_or_else(|| ApiError::new(503,
            "NATIVE_MASK_MODEL_UNAVAILABLE", "自动识别需要 models_root/clipseg-rd64-refined 内完整的本地 CLIPSeg safetensors 模型；不会自动下载"))?)
    } else {
        None
    };
    let mut loras = Vec::new();
    if let Some(id) = input["loraId"].as_str().filter(|id| !id.is_empty()) {
        let lora = catalog::lora(id).ok_or_else(|| error("UNKNOWN_LORA", "未知 Anima LoRA"))?;
        if !lora["compatibleModels"]
            .as_array()
            .is_some_and(|models| models.contains(&input["modelId"]))
        {
            return Err(error("INCOMPATIBLE_MODEL_LORA", "底模与 LoRA 组合不受支持"));
        }
        let strength = validation::number(
            &input["loraStrength"],
            "loraStrength",
            lora["minStrength"].as_f64().unwrap(),
            lora["maxStrength"].as_f64().unwrap(),
            false,
        )?;
        let path = lora_path(settings, lora).await.ok_or_else(|| {
            ApiError::new(
                503,
                "NATIVE_LORA_UNAVAILABLE",
                "独立推理目录中未找到所选 LoRA",
            )
        })?;
        loras.push(json!({"path":path,"strength":strength}));
    }
    let init_image = if let Some(name) = input["initImage"].as_str() {
        let original = originals
            .iter()
            .find(|item| item.name == name)
            .ok_or_else(|| error("TASK_INPUT_INVALID", "独立推理输入图像未保护"))?;
        input["denoisingStrength"]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0. && *n <= 1.)
            .ok_or_else(|| {
                error(
                    "INVALID_PARAMETER",
                    "denoisingStrength 必须大于 0 且不超过 1",
                )
            })?;
        Some(original.bytes.clone())
    } else {
        None
    };
    let mask_image = if let Some(name) = input["maskImage"].as_str() {
        let original = originals
            .iter()
            .find(|item| item.name == name)
            .ok_or_else(|| error("TASK_INPUT_INVALID", "独立推理遮罩图像未保护"))?;
        Some(original.bytes.clone())
    } else {
        None
    };
    Ok(Plan {
        input,
        model_dir,
        mask_model_dir,
        tea_cache_profile_path,
        settings: settings.clone(),
        init_image,
        mask_image,
        loras,
    })
}
async fn contained(root: &std::path::Path, name: &str) -> Option<PathBuf> {
    let root = tokio::fs::canonicalize(root).await.ok()?;
    let path = tokio::fs::canonicalize(root.join(name)).await.ok()?;
    (path.starts_with(&root) && path != root).then_some(path)
}
async fn lora_path(settings: &Settings, lora: &Value) -> Option<PathBuf> {
    let path = contained(&settings.loras_root, lora["file"].as_str()?).await?;
    tokio::fs::metadata(&path)
        .await
        .ok()?
        .is_file()
        .then_some(path)
}
async fn model_available(path: &std::path::Path) -> bool {
    for name in ["model_index.json", "modular_model_index.json"] {
        if tokio::fs::metadata(path.join(name))
            .await
            .is_ok_and(|m| m.is_file())
        {
            return true;
        }
    }
    false
}
async fn tea_cache_profile(model_dir: &std::path::Path) -> Option<PathBuf> {
    let path = contained(model_dir, TEACACHE_PROFILE).await?;
    let metadata = tokio::fs::metadata(&path).await.ok()?;
    (metadata.is_file() && metadata.len() > 0 && metadata.len() <= 65536).then_some(path)
}
async fn clipseg_model_dir(settings: &Settings) -> Option<PathBuf> {
    let path = contained(&settings.models_root, CLIPSEG_FOLDER).await?;
    for name in CLIPSEG_FILES {
        let file = contained(&path, name).await?;
        let metadata = tokio::fs::metadata(file).await.ok()?;
        if !metadata.is_file() || metadata.len() == 0 {
            return None;
        }
    }
    Some(path)
}
pub(super) async fn status(backend: &generation::Service, family: &str) -> Result<Value> {
    let runtime = backend.native_settings()?;
    let runtime_error = runtime.validate_files().await.err().map(|error| error.code);
    let automatic_mask = runtime_error.is_none() && clipseg_model_dir(&runtime).await.is_some();
    let mut models = Vec::new();
    for (id, model) in catalog::CATALOG["MODELS"].as_object().unwrap() {
        if family == "anima" && model["family"] != "anima" {
            continue;
        }
        let model_dir = contained(&runtime.models_root, id).await;
        let available = model["family"] == "anima"
            && runtime_error.is_none()
            && match &model_dir {
                Some(path) => model_available(path).await,
                None => false,
            };
        let profile_present = match &model_dir {
            Some(path) => tea_cache_profile(path).await.is_some(),
            None => false,
        };
        models.push(json!({"id":id,"label":model["label"],"family":model["family"],"profileId":model["profileId"],"available":available,"sizes":model["sizes"],"defaults":{"steps":model["steps"],"cfg":model["cfg"],"sampler":"euler","scheduler":"simple","teaCache":false},"teaCacheProfile":{"support":"experimental-candidate","readiness":if profile_present {"profile-files-only"} else {"missing"},"validation":"on-load","performanceVerified":false,"qualityVerified":false},"capabilities":{"negative":model["family"]=="anima","lora":model["family"]=="anima","noLora":model["noLora"]==true,"characterIdentity":model["family"]=="anima","experimental":true,"teaCache":available && profile_present,"hires":false}}));
    }
    let mut loras = Vec::new();
    {
        for (id, lora) in catalog::CATALOG["LORAS"].as_object().unwrap() {
            loras.push(json!({"id":id,"name":lora["name"],"character":lora["character"],"characters":lora["characters"],"compatibleModels":lora["compatibleModels"],"preview":lora["preview"]==true,"validation":lora["validation"].as_str().unwrap_or("production"),"available":lora_path(&runtime,lora).await.is_some(),"formatValidation":"on-load"}));
        }
    }
    let online = models.iter().any(|model| model["available"] == true);
    Ok(
        json!({"provider":"native","engine":"native","online":online,"readiness":"files-only","runtimeError":runtime_error,"models":models,"loras":loras,"styleLoras":[],"characters":catalog::CATALOG["CHARACTERS"].as_object().unwrap().values().cloned().collect::<Vec<_>>(),"hires":null,"capabilities":{"txt2img":true,"img2img":true,"mask":true,"manualMask":true,"automaticMask":automatic_mask,"experimental":true,"lora":true,"teaCache":true,"teaCacheReadiness":"per-model-profile-files-only","rcas":false,"hires":false,"upscalers":false},"pending":backend.pending(),"maxPending":4}),
    )
}

#[cfg(test)]
mod tests;
