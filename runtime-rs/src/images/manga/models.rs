//! Optional model steps share the native adapter boundary and GPU admission.
use super::*;
use crate::generation::native::adapters;
use crate::generation::native::resources;

pub(super) fn parameters(raw: &Value, result: &mut Value) -> Result<()> {
    let line_only = result["operation"] == "lineart";
    let auto = match raw.get("autoLines") {
        None => line_only,
        Some(Value::Bool(value)) => *value,
        _ => return Err(error("INVALID_PARAMETER", "autoLines 必须为布尔值")),
    };
    let has_finish = result.get("finish").is_some();
    let rewrite = raw.get("rewrite").filter(|v| !v.is_null());
    if line_only && (!auto || rewrite.is_some()) {
        return Err(error(
            "INVALID_PARAMETER",
            "仅提取线稿须启用自动提取，不能组合 Qwen 重绘",
        ));
    }
    if (auto && !line_only || rewrite.is_some()) && !has_finish {
        return Err(error(
            "INVALID_PARAMETER",
            "模型步骤需要包含网点与线条的处理方式",
        ));
    }
    if result["penLines"].is_string() && (auto || rewrite.is_some()) {
        return Err(error(
            "INVALID_PARAMETER",
            "外部线稿不能与自动线稿或 Qwen 重绘组合",
        ));
    }
    result["autoLines"] = json!(auto);
    if auto {
        result["lineartRevision"] = MANIFEST["lineart"]["revision"].clone();
    }
    if let Some(rewrite) = rewrite {
        let keys = ["modelId", "prompt", "width", "height", "seed"];
        if result.get("levels").is_some()
            || rewrite
                .as_object()
                .is_none_or(|v| v.keys().any(|k| !keys.contains(&k.as_str())))
        {
            return Err(error(
                "INVALID_PARAMETER",
                "Qwen 重绘使用 comic/finish；仅接受 modelId、prompt、width、height、seed",
            ));
        }
        if !MANIFEST["rewrite"]["models"]
            .as_array()
            .unwrap()
            .contains(&rewrite["modelId"])
        {
            return Err(error(
                "INVALID_PARAMETER",
                "漫画重绘仅接入 Qwen-Image 2.1 / Turbo",
            ));
        }
        let validated = super::super::native_adapters::validate(rewrite, "qwen-image")?;
        if validated["width"].as_u64().unwrap() * validated["height"].as_u64().unwrap()
            > MANIFEST["maxInputPixels"].as_u64().unwrap()
        {
            return Err(error("INVALID_PARAMETER", "重绘结果不得超过 2097152 像素"));
        }
        result["rewrite"] = Value::Object(
            keys.iter()
                .map(|key| ((*key).into(), validated[*key].clone()))
                .collect(),
        );
        let spec = adapters::model(validated["modelId"].as_str().unwrap()).unwrap();
        result["rewriteModelRevision"] = spec["revision"].clone();
        result["rewriteSteps"] = spec["steps"].clone();
        result["rewriteCfg"] = spec["cfg"].clone();
        result["device"] = json!("cuda+cpu");
    }
    Ok(())
}

fn line_issue(settings: &Settings) -> Option<String> {
    let directory = settings.models_root.join("manga-line-extraction");
    let path = directory.join("erika.pth");
    if resources::file(
        &settings.models_root,
        "manga-line-extraction/erika.pth",
        true,
    )
    .is_none()
        || directory.is_symlink()
        || path.is_symlink()
        || !std::fs::metadata(&path).is_ok_and(|m| m.len() <= 256 * 1024 * 1024)
    {
        Some("模型根目录缺少 manga-line-extraction/erika.pth（官方 v1 权重）；不会自动下载".into())
    } else {
        None
    }
}

pub(super) async fn model_dir(settings: &Settings, input: &Value) -> Result<PathBuf> {
    if input["autoLines"] == true {
        let runtime = settings.clone();
        let issue = tokio::task::spawn_blocking(move || line_issue(&runtime))
            .await
            .map_err(|_| {
                ApiError::new(
                    503,
                    "MANGA_LINE_MODEL_MISSING",
                    "线稿模型文件读取未完成，请重试",
                )
            })?;
        if let Some(reason) = issue {
            return Err(ApiError::new(503, "MANGA_LINE_MODEL_MISSING", reason));
        }
    }
    if input["rewrite"].is_object() {
        // Reuse the same local layout validation, adapter execution settings and
        // model root containment as the existing Qwen image API.
        let plan = adapters::plan(settings, input["rewrite"].clone(), None).await?;
        Ok(plan.model_dir)
    } else {
        Ok(PathBuf::new())
    }
}

pub(super) fn status(settings: &Settings) -> Value {
    let issue = line_issue(settings);
    json!({"rewrite":MANIFEST["rewrite"]["models"].as_array().unwrap().iter()
        .map(|id| adapters::status(settings, id.as_str().unwrap())).collect::<Vec<_>>(),
        "lineart":{"available":issue.is_none(),"unavailableReason":issue,"readiness":"files-only",
            "device":"cpu","validation":"主力机已验证"},"memoryPolicy":settings.adapter_memory_policy})
}
