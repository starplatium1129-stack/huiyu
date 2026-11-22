use super::*;

pub(in crate::images) async fn status(
    backend: &generation::Service,
    family: &str,
    cancel: CancellationToken,
) -> Result<Value> {
    status_check(&cancel)?;
    let runtime = backend.native_settings()?;
    let runtime_error = if family.is_empty() || family == "anima" {
        runtime
            .validate_anima_files()
            .await
            .err()
            .map(|error| error.code)
    } else {
        None
    };
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
    let mut adapter_models = Vec::new();
    if family != "anima" {
        let adapters = generation::native::adapters::Status::new(runtime);
        for (id, spec) in generation::native::adapters::manifest()["models"]
            .as_object()
            .unwrap()
        {
            status_check(cancel)?;
            if spec["media"] == "image" && (family.is_empty() || spec["family"] == family) {
                adapter_models.push(adapters.model(id));
            }
        }
        if !family.is_empty() && !adapter_models.is_empty() {
            let online = adapter_models.iter().any(|model| model["available"] == true);
            let edit = adapter_models
                .iter()
                .any(|model| model["capabilities"]["img2img"] == true);
            let mut value = json!({"provider":"native","engine":"native","online":online,"readiness":"files-only",
                "validation":"待主力机验证","runtimeError":adapters.runtime_error.map(|e| e.code),
                "models":null,"loras":[],"characters":[],"styleLoras":[],"hires":null,"pending":0,"maxPending":generation::native::MAX_PENDING,
                "capabilities":{"txt2img":true,"img2img":edit,"mask":false,"manualMask":false,"automaticMask":false,
                "experimental":true,"lora":false,"teaCache":false,"rcas":false,"hires":false,"weightSyntax":false}});
            value["models"] = Value::Array(adapter_models);
            if family == "keyframe" {
                value["capabilities"]["txt2img"] = json!(false);
            }
            if family == "krea2" {
                value["styleLoras"] = json!(native_adapters::styles(runtime));
            }
            return Ok(value);
        }
    }
    let automatic_mask =
        runtime_error.is_none() && resources::clipseg(&runtime.models_root).is_some();
    status_check(cancel)?;
    let remacri = runtime_error.is_none() && resources::remacri(&runtime.models_root).is_some();
    let ultrasharp = runtime_error.is_none() && resources::ultrasharp(&runtime.models_root).is_some();
    let mut hires_upscalers = if remacri {
        vec!["Auto", "Latent", "Remacri"]
    } else {
        vec!["Auto", "Latent"]
    };
    if ultrasharp { hires_upscalers.push("4x-UltraSharp"); }
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
            defaults["loraStrength"] = json!(0.8);
        }
        let mut entry = json!({"id":id,"label":model["label"],"family":model["family"],"profileId":model["profileId"],"available":available,"readiness":if available {"files-ready"} else {"unavailable"},"unavailableReason":issue,"sizes":model["sizes"],"defaults":defaults,"teaCacheProfile":{"support":"builtin-anima","readiness":"builtin","policy":"builtin-anima","validation":"on-load","performanceVerified":false,"qualityVerified":false},"capabilities":{"negative":model["family"]=="anima","lora":model["family"]=="anima","noLora":model["noLora"]==true,"characterIdentity":model["family"]=="anima","experimental":true,"teaCache":available,"hires":model["family"]=="anima","rcas":model["family"]=="anima","weightSyntax":model["family"]=="anima","hiresUpscalers":if model["family"]=="anima" {hires_upscalers.clone()} else {vec![]}}});
        entry["capabilities"]["lora"] = json!(model["lora"] != false);
        if model["family"] == "anima" {
            entry["capabilities"]["customSize"] = validation::anima_size_limits();
        }
        let sketch = composition::status(
            runtime,
            model_dir.as_deref(),
            available && model["family"] == "anima",
        );
        entry["capabilities"]["sketchControl"] = sketch["available"].clone();
        entry["capabilities"]["sketchControlStatus"] = sketch;
        entry["capabilities"]["regionalPrompting"] =
            json!(available && model["family"] == "anima" && runtime.acceleration == "native");
        models.push(entry);
    }
    models.extend(adapter_models);
    let mut loras = Vec::new();
    {
        for (id, lora) in catalog::CATALOG["LORAS"].as_object().unwrap() {
            status_check(cancel)?;
            let available = lora["file"]
                .as_str()
                .is_some_and(|name| resources::file(&runtime.loras_root, name, false).is_some());
            loras.push(json!({"id":id,"name":lora["name"],"character":lora["character"],"characters":lora["characters"],"compatibleModels":lora["compatibleModels"],"preview":lora["preview"]==true,"validation":lora["validation"].as_str().unwrap_or("production"),"available":available,"formatValidation":"on-load"}));
        }
    }
    let online = models.iter().any(|model| model["available"] == true);
    let styles = if family.is_empty() || family == "krea2" {
        native_adapters::styles(runtime)
    } else {
        vec![]
    };
    let mut value = json!({"provider":"native","engine":"native","online":online,"readiness":"files-only","runtimeError":runtime_error,"models":models,"loras":loras,"styleLoras":[],"characters":catalog::CATALOG["CHARACTERS"].as_object().unwrap().values().cloned().collect::<Vec<_>>(),"hires":{"superResModel":if remacri {Some(REMACRI_FILE)} else {None}},"capabilities":{"txt2img":true,"img2img":true,"mask":true,"manualMask":true,"automaticMask":automatic_mask,"experimental":true,"lora":true,"teaCache":true,"teaCacheReadiness":"builtin","rcas":true,"hires":true,"hiresTeaCache":true,"upscalers":remacri,"hiresUpscalers":hires_upscalers,"weightSyntax":true},"pending":0,"maxPending":generation::native::MAX_PENDING});
    value["styleLoras"] = json!(styles);
    Ok(value)
}
