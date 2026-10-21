use super::*;
use generation::native::{Plan, Settings};
use generation::native::resources::{self, REMACRI_FILE};

fn supported_sampling(input: &Value) -> bool {
    matches!(input["sampler"].as_str(), Some("euler" | "res_multistep"))
        && matches!(
            input["scheduler"].as_str(),
            Some("simple" | "normal" | "sgm_uniform")
        )
}

pub(super) fn normalize(raw: &Value, mut input: Value) -> Result<Value> {
    if input["family"] == "manga-screen" {
        return manga::normalize(&input);
    }
    if generation::native::adapters::model(input["modelId"].as_str().unwrap_or("")).is_some() {
        return native_adapters::normalize(raw, input);
    }
    if input["family"] != "anima" {
        return Err(ApiError::new(
            501,
            "NATIVE_FAMILY_UNSUPPORTED",
            "独立推理当前仅支持 Anima",
        ));
    }
    // Defaults belong to the selected provider. Explicit unsupported requests
    // are never silently converted into a different operation.
    for key in ["styleLoraId", "rcas", "faceDetailer"] {
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
        let phrases = prompt
            .split('|')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .count();
        if prompt.chars().count() > 4096 || phrases == 0 || phrases > 32 {
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
    // Public requests cannot supply these fields. Preserve the catalog recipe
    // already normalized by validation, and the frozen recipe on task resume.
    if input["sampler"].is_null() {
        input["sampler"] = json!("res_multistep");
    }
    if input["scheduler"].is_null() {
        input["scheduler"] = json!("simple");
    }
    if !supported_sampling(&input) {
        return Err(ApiError::new(
            501,
            "NATIVE_FEATURE_UNSUPPORTED",
            "原生推理不支持该采样组合",
        ));
    }
    let tea_cache = match raw.get("teaCache") {
        None => true,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => return Err(error("INVALID_PARAMETER", "独立推理 teaCache 必须为布尔值")),
    };
    input["teaCache"] = json!(tea_cache);
    // Retain the host marker for saved task recipes. Both modes now use the
    // bundled Anima strategy; neither requires a per-recipe calibration file.
    input["teaCacheAuto"] = json!(raw.get("teaCache").is_none());
    if input["hiresFix"] == true {
        validation::number(&input["hiresScale"], "hiresScale", 1.1, 3., false)?;
        validation::number(&input["hiresDenoise"], "hiresDenoise", 0.1, 0.7, false)?;
        if !matches!(
            raw.get("hiresUpscaler")
                .unwrap_or(&input["hiresUpscaler"])
                .as_str(),
            Some("Auto" | "Latent" | "Remacri")
        ) {
            return Err(ApiError::new(
                501,
                "NATIVE_FEATURE_UNSUPPORTED",
                "原生高清放大仅支持 Auto、Latent 或 Remacri",
            ));
        }
    }
    // Share the Comfy workflow threshold, including restored numeric settings.
    input.as_object_mut().unwrap().remove("teaCacheThresh");
    if let Some(threshold) = raw.get("teaCacheThresh") {
        let threshold = validation::number(threshold, "teaCacheThresh", 0., 1., false)?;
        if tea_cache {
            input["teaCacheThresh"] = threshold;
        }
    } else if tea_cache {
        input["teaCacheThresh"] = json!(0.10);
    }
    input["inferenceEngine"] = json!("native");
    composition::normalize_native(raw, &mut input)?;
    Ok(input)
}
pub(super) async fn plan(
    settings: &Settings,
    input: Value,
    originals: &[inputs::Original],
) -> Result<Plan> {
    if input["family"] == "manga-screen" {
        return manga::plan(settings, input, originals).await;
    }
    if generation::native::adapters::model(input["modelId"].as_str().unwrap_or("")).is_some() {
        let input = native_adapters::normalize(&input, input.clone())?;
        let image = input["initImage"].as_str().map(|name| originals.iter().find(|o| o.name == name)
            .map(|o| o.input.clone()).ok_or_else(|| ApiError::new(409, "TASK_INPUT_MISSING", "缺少受保护的编辑原图"))).transpose()?;
        let references = input["referenceImages"].as_array().into_iter().flatten().map(|value| {
            originals.iter().find(|original| Some(original.name.as_str()) == value.as_str()).map(|original| original.input.clone())
                .ok_or_else(|| ApiError::new(409, "TASK_INPUT_MISSING", "缺少受保护的参考图"))
        }).collect::<Result<Vec<_>>>()?;
        let plan = native_adapters::plan(settings, input, image).await?;
        *plan.reference_images.lock().unwrap() = references;
        return Ok(plan);
    }
    if input["inferenceEngine"] != "native"
        || input["family"] != "anima"
        || !supported_sampling(&input)
    {
        return Err(ApiError::new(
            409,
            "TASK_RESUME_UNSAFE",
            "独立推理参数与当前能力不匹配",
        ));
    }
    normalize(&input, input.clone())?;
    settings.validate_anima_files().await?;
    let settings = settings.clone();
    let originals = originals.to_vec();
    // All local recognition shares status/discovery rules, off the async executor.
    tokio::task::spawn_blocking(move || anima_plan(&settings, input, &originals))
        .await.map_err(|_| ApiError::new(503, "NATIVE_MODEL_UNAVAILABLE", "模型组件读取未完成，请重试"))?
}
fn anima_plan(settings: &Settings, mut input: Value, originals: &[inputs::Original]) -> Result<Plan> {
    let id = input["modelId"]
        .as_str()
        .ok_or_else(|| error("UNKNOWN_MODEL", "未知生成模型"))?
        .to_owned();
    catalog::model(&id)?;
    let model_dir = resources::within(&settings.models_root, &settings.models_root.join(&id)).ok_or_else(|| {
        ApiError::new(
            503,
            "NATIVE_MODEL_UNAVAILABLE",
            "独立推理需要完整本地 Diffusers 模型目录",
        )
    })?;
    if let Some(reason) = generation::native::model_issue(&model_dir) {
        return Err(ApiError::new(
            503,
            "NATIVE_MODEL_UNAVAILABLE",
            format!("原生模型尚未就绪：{reason}"),
        ));
    }
    let upscale_model_path = if input["hiresFix"] == true {
        input["requestedHiresUpscaler"] = input
            .get("requestedHiresUpscaler")
            .cloned()
            .unwrap_or_else(|| input["hiresUpscaler"].clone());
        let resource = resources::remacri(&settings.models_root);
        let requested = input["hiresUpscaler"].as_str().unwrap_or("Auto");
        if requested == "Remacri" && resource.is_none() {
            return Err(ApiError::new(
                503,
                "NATIVE_UPSCALER_UNAVAILABLE",
                "Remacri 需要独立模型根目录 upscale_models 内的固定 safetensors 文件",
            ));
        }
        let selected = if requested == "Latent" {
            None
        } else {
            resource
        };
        input["hiresUpscaler"] = json!(if selected.is_some() {
            "Remacri"
        } else {
            "Latent"
        });
        input["superResModel"] = selected
            .as_ref()
            .map(|_| json!(REMACRI_FILE))
            .unwrap_or(Value::Null);
        let model = catalog::model(&id)?;
        input["hiresSampler"] = input
            .get("hiresSampler")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| {
                model
                    .get("hiresSampler")
                    .unwrap_or(&catalog::contract()["HIRES_SAMPLER"])
                    .clone()
            });
        input["hiresScheduler"] = input
            .get("hiresScheduler")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| {
                model
                    .get("hiresScheduler")
                    .unwrap_or(&catalog::contract()["HIRES_SCHEDULER"])
                    .clone()
            });
        selected
    } else {
        input["superResModel"] = Value::Null;
        None
    };
    let init = generation::truthy(&input["initImage"]);
    let masked =
        generation::truthy(&input["maskImage"]) || generation::truthy(&input["maskPrompt"]);
    let sharpen = if input["hiresFix"] == true {
        upscale_model_path.is_none()
    } else {
        !init
    };
    // Masked latent hires sharpens the generated source before final composite.
    // Pixel Remacri (including masked refinement) has no extra RCAS pass.
    input["rcasStrength"] = json!(if sharpen { 0.75 } else { 0. });
    if input["hiresFix"] == true && !masked && upscale_model_path.is_some() {
        input["hiresSampler"] = Value::Null;
        input["hiresScheduler"] = Value::Null;
    }
    let mask_model_dir = if input["maskPrompt"]
        .as_str()
        .is_some_and(|prompt| !prompt.is_empty())
    {
        Some(resources::clipseg(&settings.models_root).ok_or_else(|| ApiError::new(503,
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
        let path = lora["file"].as_str().and_then(|name| resources::file(&settings.loras_root, name, false)).ok_or_else(|| {
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
        Some(original.input.clone())
    } else {
        None
    };
    let mask_image = if let Some(name) = input["maskImage"].as_str() {
        let original = originals
            .iter()
            .find(|item| item.name == name)
            .ok_or_else(|| error("TASK_INPUT_INVALID", "独立推理遮罩图像未保护"))?;
        Some(original.input.clone())
    } else {
        None
    };
    let sketch_model_path = composition::prepare(settings, &mut input, &model_dir)?;
    let sketch_image = input["sketchControl"]["image"].as_str().map(|name| originals.iter()
        .find(|original| original.name == name).map(|original| original.input.clone())
        .ok_or_else(|| error("TASK_INPUT_INVALID", "草图输入尚未保护"))).transpose()?;
    Ok(Plan {
        input: input.into(),
        model_dir,
        mask_model_dir,
        upscale_model_path,
        settings: settings.clone(),
        init_image: std::sync::Mutex::new(init_image),
        reference_images: std::sync::Mutex::new(vec![]),
        mask_image: std::sync::Mutex::new(mask_image),
        pen_lines: std::sync::Mutex::new(None),
        sketch_image: std::sync::Mutex::new(sketch_image),
        sketch_model_path,
        loras,
    })
}
pub(super) async fn status(
    backend: &generation::Service,
    family: &str,
    cancel: CancellationToken,
) -> Result<Value> {
    status_check(&cancel)?;
    let runtime = backend.native_settings()?;
    let runtime_error = runtime.validate_anima_files().await.err().map(|error| error.code);
    let family = family.to_owned();
    // One bounded filesystem job per poll, with no completed-result cache.
    let mut value = tokio::task::spawn_blocking(move || {
        local_status(&runtime, &family, runtime_error, &cancel)
    })
    .await
    .map_err(|_| ApiError::new(503, "ANIMA_STATUS_UNAVAILABLE", "生成资源状态暂不可用"))??;
    value["pending"] = json!(backend.pending());
    Ok(value)
}
fn status_check(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(inputs::cancelled())
    } else {
        Ok(())
    }
}
fn local_status(
    runtime: &Settings,
    family: &str,
    runtime_error: Option<String>,
    cancel: &CancellationToken,
) -> Result<Value> {
    status_check(cancel)?;
    let automatic_mask = runtime_error.is_none() && resources::clipseg(&runtime.models_root).is_some();
    status_check(cancel)?;
    let remacri = runtime_error.is_none() && resources::remacri(&runtime.models_root).is_some();
    let hires_upscalers = if remacri {
        vec!["Auto", "Latent", "Remacri"]
    } else {
        vec!["Auto", "Latent"]
    };
    let mut models = Vec::new();
    for (id, model) in catalog::CATALOG["MODELS"].as_object().unwrap() {
        status_check(cancel)?;
        if model["family"] != "anima" || !family.is_empty() && model["family"] != family {
            continue;
        }
        let model_dir = resources::within(&runtime.models_root, &runtime.models_root.join(id));
        let issue = if runtime_error.is_some() {
            Some("独立推理运行库不可用".to_owned())
        } else if let Some(path) = &model_dir {
            // One unreadable model must not hide other status entries.
            std::panic::catch_unwind(|| generation::native::model_issue(path))
                .unwrap_or_else(|_| Some("模型组件读取未完成，请重试".into()))
        } else {
            Some("当前模型根目录内尚未安装此模型".to_owned())
        };
        let available = issue.is_none();
        let mut defaults = json!({"steps":model["steps"],"cfg":model["cfg"],"sampler":model["sampler"],"scheduler":model["scheduler"],"teaCache":true,"teaCachePolicy":"builtin-anima","teaCacheThresh":0.10});
        if id == "anima-miaomiao-v1.6" {
            defaults["steps"] = json!(24);
            defaults["cfg"] = json!(4.);
            defaults["loraStrength"] = json!(0.8);
        }
        let mut entry = json!({"id":id,"label":model["label"],"family":model["family"],"profileId":model["profileId"],"available":available,"readiness":if available {"files-ready"} else {"unavailable"},"unavailableReason":issue,"sizes":model["sizes"],"defaults":defaults,"teaCacheProfile":{"support":"builtin-anima","readiness":"builtin","policy":"builtin-anima","validation":"on-load","performanceVerified":false,"qualityVerified":false},"capabilities":{"negative":model["family"]=="anima","lora":model["family"]=="anima","noLora":model["noLora"]==true,"characterIdentity":model["family"]=="anima","experimental":true,"teaCache":available,"hires":model["family"]=="anima","rcas":model["family"]=="anima","weightSyntax":model["family"]=="anima","hiresUpscalers":if model["family"]=="anima" {hires_upscalers.clone()} else {vec![]}}});
        let sketch = composition::status(runtime, model_dir.as_deref(), available && model["family"] == "anima");
        entry["capabilities"]["sketchControl"] = sketch["available"].clone();
        entry["capabilities"]["sketchControlStatus"] = sketch;
        entry["capabilities"]["regionalPrompting"] = json!(available && model["family"] == "anima" && runtime.acceleration == "native");
        models.push(entry);
    }
    for (id, model) in generation::native::adapters::manifest()["models"].as_object().unwrap() {
        status_check(cancel)?;
        if model["media"] == "image" && (family.is_empty() || model["family"] == family) {
            models.push(generation::native::adapters::status(runtime, id));
        }
    }
    let mut loras = Vec::new();
    {
        for (id, lora) in catalog::CATALOG["LORAS"].as_object().unwrap() {
            status_check(cancel)?;
            let available = lora["file"].as_str()
                .is_some_and(|name| resources::file(&runtime.loras_root, name, false).is_some());
            loras.push(json!({"id":id,"name":lora["name"],"character":lora["character"],"characters":lora["characters"],"compatibleModels":lora["compatibleModels"],"preview":lora["preview"]==true,"validation":lora["validation"].as_str().unwrap_or("production"),"available":available,"formatValidation":"on-load"}));
        }
    }
    let online = models.iter().any(|model| model["available"] == true);
    let styles = if family.is_empty() || family == "krea2" { native_adapters::styles(runtime) } else { vec![] };
    let mut value = json!({"provider":"native","engine":"native","online":online,"readiness":"files-only","runtimeError":runtime_error,"models":models,"loras":loras,"styleLoras":[],"characters":catalog::CATALOG["CHARACTERS"].as_object().unwrap().values().cloned().collect::<Vec<_>>(),"hires":{"superResModel":if remacri {Some(REMACRI_FILE)} else {None}},"capabilities":{"txt2img":true,"img2img":true,"mask":true,"manualMask":true,"automaticMask":automatic_mask,"experimental":true,"lora":true,"teaCache":true,"teaCacheReadiness":"builtin","rcas":true,"hires":true,"hiresTeaCache":true,"upscalers":remacri,"hiresUpscalers":hires_upscalers,"weightSyntax":true},"pending":0,"maxPending":4});
    value["styleLoras"] = json!(styles);
    if matches!(family, "krea2" | "qwen-image") {
        value["capabilities"] = json!({"txt2img":true,"img2img":family=="qwen-image","mask":false,"manualMask":false,
            "automaticMask":false,"experimental":true,"lora":false,"teaCache":false,"rcas":false,"hires":false,"weightSyntax":false});
        value["loras"] = json!([]);
        value["characters"] = json!([]);
        value["hires"] = Value::Null;
        value["validation"] = json!("待主力机验证");
        value["runtimeError"] = generation::native::adapters::settings(runtime).err().map(|e| json!(e.code)).unwrap_or(Value::Null);
    }
    Ok(value)
}
