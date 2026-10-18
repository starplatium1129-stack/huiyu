use super::*;
use generation::native::adapters;

pub(super) fn validate(raw: &Value, size: Option<(u32, u32)>) -> Result<Value> {
    let id = raw["modelId"].as_str().unwrap_or("");
    let spec = video_model(id)?;
    supported(raw, spec)?;
    let mut input = validation::validate_for(raw, size, Some(spec))?;
    input["inferenceEngine"] = json!("native");
    normalize(input)
}
fn video_model(id: &str) -> Result<&'static Value> {
    adapters::model(id)
        .filter(|m| m["media"] == "video")
        .ok_or_else(|| {
            error(
                501,
                "NATIVE_VIDEO_UNSUPPORTED",
                "该模型尚无原生视频适配；不会回退 ComfyUI",
            )
        })
}
fn supported(input: &Value, spec: &Value) -> Result<()> {
    for key in [
        "image",
        "lastFrame",
        "references",
        "dialogue",
        "dialogueLang",
        "shotSize",
    ] {
        if generation::truthy(&input[key]) {
            return Err(error(
                501,
                "NATIVE_VIDEO_UNSUPPORTED",
                format!("该原生文生视频入口尚未接入 {key}"),
            ));
        }
    }
    if spec["negative"] != true
        && input["negative"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
    {
        return Err(error(
            400,
            "NATIVE_VIDEO_UNSUPPORTED",
            "H3 引导已蒸馏到权重，不接受负向提示词",
        ));
    }
    Ok(())
}
pub(super) fn normalize(mut input: Value) -> Result<Value> {
    if input["inferenceEngine"] != "native" {
        return Err(error(
            409,
            "TASK_RESUME_UNSAFE",
            "旧视频配方没有原生引擎身份，请重新创建任务",
        ));
    }
    let spec = video_model(input["modelId"].as_str().unwrap_or(""))?;
    supported(&input, spec)?;
    for key in ["width", "height"] {
        if !input[key].as_u64().is_some_and(|n| {
            (spec["minSize"].as_u64().unwrap_or(512)..=spec["maxSize"].as_u64().unwrap())
                .contains(&n)
                && n % spec["alignment"].as_u64().unwrap() == 0
        }) {
            return Err(error(
                400,
                "INVALID_PARAMETER",
                "原生视频宽高不符合所选版本的范围/对齐要求",
            ));
        }
    }
    if !input["steps"]
        .as_u64()
        .is_some_and(|n| (spec["minSteps"].as_u64().unwrap_or(1)..=100).contains(&n))
        || input["fps"] != spec["fps"]
        || input["cfg"] != spec["cfg"]
        || !input["frames"].as_u64().is_some_and(|n| {
            (spec["minFrames"].as_u64().unwrap()..=spec["maxFrames"].as_u64().unwrap()).contains(&n)
                && (n - spec["frameOffset"].as_u64().unwrap())
                    % spec["frameMultiple"].as_u64().unwrap()
                    == 0
        })
        || input["duration"]
            .as_u64()
            .is_none_or(|n| spec["durationFrames"][n.to_string()] != input["frames"])
    {
        return Err(error(
            400,
            "INVALID_PARAMETER",
            "原生视频帧数/步数/帧率/引导配方不匹配",
        ));
    }
    if let Some(canvases) = spec["canvases"].as_object() {
        if input["quality"] != "standard"
            || !canvases
                .values()
                .any(|c| c[0] == input["width"] && c[1] == input["height"])
        {
            return Err(error(
                400,
                "INVALID_PARAMETER",
                "Hunyuan 480p T2V 仅支持声明的 standard 画布",
            ));
        }
    }
    input["family"] = spec["family"].clone();
    input["mediaKind"] = json!("video");
    input["nativeAdapterVersion"] = json!(1);
    input["validation"] = json!("待主力机验证");
    // Zero means unknown to existing clients; never reuse Comfy timing estimates.
    input["estimatedSeconds"] = json!(0);
    input["sampler"] = spec["sampler"].clone();
    input["scheduler"] = json!("model-config");
    input["audio"] = spec["audio"].clone();
    input["encodedDuration"] =
        json!(input["frames"].as_f64().unwrap() / input["fps"].as_f64().unwrap());
    Ok(input)
}
pub(super) async fn status(backend: &generation::Service) -> Result<Value> {
    let settings = backend.native_settings()?;
    let models = tokio::task::spawn_blocking(move || {
        catalog::constants()["MODEL_CATALOG"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                let id = item["id"].as_str().unwrap();
                let mut status = item.clone();
                status
                    .as_object_mut()
                    .unwrap()
                    .extend(adapters::status(&settings, id).as_object().unwrap().clone());
                let supported = adapters::model(id).is_some_and(|m| m["media"] == "video");
                status["executable"] = json!(supported);
                status["modes"] = if supported {
                    json!(["text"])
                } else {
                    json!([])
                };
                let reason = status["unavailableReason"]
                    .as_str()
                    .unwrap_or("待主力机验证")
                    .to_owned();
                status["reason"] = json!(reason);
                status["tier"] = json!("待主力机验证");
                status["summary"] = json!(if supported {
                    "原生文生视频代码接入；音轨能力见 audio，显存与性能尚无实测"
                } else {
                    "尚未接入原生执行"
                });
                status["remaining"] = adapters::manifest()["pendingVideo"][id].clone();
                status["requirements"] = if supported {
                    json!([
                        "独立 adapters Python 环境",
                        format!("{id}/ 完整指定 Diffusers 目录"),
                        "ffmpeg（libx264；H3/LTX 另需 AAC）"
                    ])
                } else {
                    json!([])
                };
                status["missing"] = if status["available"] == true {
                    json!([])
                } else {
                    json!([reason])
                };
                status
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|_| error(503, "NATIVE_STATUS_UNAVAILABLE", "原生视频目录检查未完成"))?;
    let qualities = catalog::constants()["QUALITIES"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, q)| {
            let sizes = q["sizes"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(id, s)| {
                    (
                        id.clone(),
                        json!(format!("{} × {}", s["width"], s["height"])),
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            json!({"id":id,"label":q["label"],"summary":q["summary"],"sizes":sizes})
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"engine":"native","provider":"native","readiness":"files-only","validation":"待主力机验证",
        "online":models.iter().any(|m| m["available"]==true),"models":models,"pending":backend.pending(),"maxPending":4,
        "defaults":{"modelId":"wan2.2-ti2v-5b","aspectRatio":"landscape","duration":3,"camera":"still","motion":"subtle","quality":"standard","steps":50},
        "qualities":qualities,"t8":{"available":false,"reason":"原生适配未接入 H3 T8"}}),
    )
}
