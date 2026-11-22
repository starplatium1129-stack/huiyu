use super::*;
use generation::native::adapters;
use std::path::Path;

#[derive(Default)]
pub(super) struct PackedH3 {
    steps: Vec<u64>,
    lightvae: bool,
    sla: bool,
    fused: bool,
}

fn local_pack(root: &Path) -> Option<PackedH3> {
    let steps = adapters::h3_packed_steps(root)?;
    Some(PackedH3 { steps, lightvae: adapters::h3_accelerator(root, "lightvae"), sla: adapters::h3_accelerator(root, "sla"),
        fused: adapters::h3_accelerator(root, "fused") })
}

pub(super) async fn packed_h3(
    settings: &generation::native::Settings,
    id: &Value,
) -> Result<Option<PackedH3>> {
    if id != "minimax-h3" {
        return Ok(None);
    }
    let root = settings.models_root.join("minimax-h3");
    tokio::task::spawn_blocking(move || local_pack(&root)).await
        .map_err(|_| error(503, "NATIVE_STATUS_UNAVAILABLE", "读取本机 H3 配方失败，请重新检查"))
}

pub(super) fn validate(
    raw: &Value,
    size: Option<(u32, u32)>,
    pack: Option<&PackedH3>,
) -> Result<Value> {
    let id = raw["modelId"].as_str().unwrap_or("");
    let spec = video_model(id)?;
    supported(raw, spec)?;
    let mut input = validation::validate_for(raw, size, Some(spec))?;
    input["inferenceEngine"] = json!("native");
    if let Some(pack) = pack {
        if raw.get("steps").is_none() {
            input["steps"] = json!(pack.steps[0]);
        }
        input["h3Decoder"] = raw.get("h3Decoder").cloned()
            .unwrap_or_else(|| json!(if pack.lightvae { "lightvae" } else { "original" }));
        input["h3VideoShift"] = json!(if input["steps"] == 4 && input["videoAttention"] != "h3-fused" { 6 } else { 12 });
        input["nativeModelFormat"] = spec["localPack"]["format"].clone();
    }
    Ok(input)
}
pub(super) fn video_model(id: &str) -> Result<&'static Value> {
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
    validation::validate_frames(input, spec)?;
    if spec["runner"] == "wan-a14b-sd" && !validation::present(&input["image"]) {
        return Err(error(400, "MODEL_INPUT_MODE", "Wan A14B 图生视频需要首帧。"));
    }
    for (key, kind, mime, label) in [
        ("drivingVideo", "video", "video/mp4", "动作视频"),
        ("drivingAudio", "audio", "audio/wav", "配音 WAV"),
    ] {
        if spec["drivingInput"] == kind {
            if !input["image"].as_str().is_some_and(|name| inputs::valid_name(name, false))
                || input[key].as_str().and_then(inputs::driver_mime) != Some(mime) {
                return Err(error(400, "MODEL_INPUT_MODE", format!("此模型需要角色图片和{label}")));
            }
        } else if input.get(key).is_some() {
            return Err(error(400, "MODEL_INPUT_MODE", format!("所选模型不接收{label}")));
        }
    }
    if validation::present(&input["lastFrame"]) && !validation::present(&input["image"]) {
        return Err(error(
            400,
            "MODEL_INPUT_MODE",
            "首尾帧模式需要同时提供首帧和尾帧",
        ));
    }
    for key in ["references", "dialogue", "dialogueLang", "shotSize"] {
        if generation::truthy(&input[key]) {
            return Err(error(
                501,
                "NATIVE_VIDEO_UNSUPPORTED",
                format!("该原生视频入口尚未接入 {key}"),
            ));
        }
    }
    if input.get("promptRecipe").is_none()
        && spec["negative"] != true
        && input["negative"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
    {
        return Err(error(
            400,
            "NATIVE_VIDEO_UNSUPPORTED",
            "所选模型的配方不接受负向提示词",
        ));
    }
    Ok(())
}
pub(super) fn normalize(mut input: Value, pack: Option<&PackedH3>) -> Result<Value> {
    if input["inferenceEngine"] != "native" {
        return Err(error(
            409,
            "TASK_RESUME_UNSAFE",
            "旧视频配方没有原生引擎身份，请重新创建任务",
        ));
    }
    let spec = video_model(input["modelId"].as_str().unwrap_or(""))?;
    supported(&input, spec)?;
    let format = pack.map(|_| &spec["localPack"]["format"]);
    if input.get("nativeModelFormat") != format {
        return Err(error(409, "TASK_RESUME_UNSAFE", "此任务保存的模型配方与本机视频权重不匹配，请核对所选模型"));
    }
    if let Some(options) = pack.map(|p| &p.steps)
        && !input["steps"].as_u64().is_some_and(|n| options.contains(&n))
    {
        let supported = options.iter().map(u64::to_string).collect::<Vec<_>>().join(" 或 ");
        return Err(error(400, "INVALID_PARAMETER", format!("本机 H3 Turbo 支持 {supported} 步，请调整生成步数")));
    }
    match input.get("videoAttention").map(Value::as_str) {
        None => input["videoAttention"] = json!("auto"),
        Some(Some("auto" | "sdpa" | "sage" | "flash2")) => {}
        Some(Some("h3-sol")) if pack.is_some() => {}
        Some(Some("h3-sla")) if pack.is_some_and(|p| p.sla) && input["steps"] == 4 => {}
        Some(Some("h3-sla")) => return Err(error(400, "UNSUPPORTED_ACCELERATION", "SLA 加速需要本机的 H3 四步 SLA 权重")),
        Some(Some("h3-fused")) if pack.is_some_and(|p| p.fused) && input["steps"] == 4 => {}
        Some(Some("h3-fused")) => return Err(error(400, "UNSUPPORTED_ACCELERATION", "社区融合加速需要本机的 Fused Turbo 权重及四步配方")),
        _ => return Err(error(400, "INVALID_PARAMETER", "未知的原生视频注意力选项")),
    }
    match input.get("h3Decoder").map(Value::as_str) {
        None => {} // Older tasks used the original decoder.
        Some(Some("original")) if pack.is_some() => {}
        Some(Some("lightvae")) if pack.is_some_and(|p| p.lightvae) => {}
        _ => return Err(error(400, "UNSUPPORTED_ACCELERATION", "所选 H3 视频解码器在本机未就绪")),
    }
    if pack.is_some() {
        // Jobs saved by the original importer used 12 for both adapter releases.
        if input.get("h3VideoShift").is_none() { input["h3VideoShift"] = json!(12); }
        if !matches!(input["h3VideoShift"].as_u64(), Some(12))
            && !(input["steps"] == 4 && input["h3VideoShift"] == 6) {
            return Err(error(409, "TASK_RESUME_UNSAFE", "H3 视频采样参数与保存的配方不符"));
        }
    }
    if spec["attentionModes"].as_array().is_some_and(|modes| !modes.contains(&input["videoAttention"])) {
        return Err(error(400, "UNSUPPORTED_ACCELERATION", "所选注意力内核与此模型不兼容"));
    }
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
        || (spec["distilled"] == true && !spec["stepOptions"].as_array()
            .map_or(input["steps"] == spec["steps"], |options| options.contains(&input["steps"])))
        || !input["frames"].as_u64().is_some_and(|n| {
            (spec["minFrames"].as_u64().unwrap()..=spec["maxFrames"].as_u64().unwrap()).contains(&n)
                && (n - spec["frameOffset"].as_u64().unwrap())
                    % spec["frameMultiple"].as_u64().unwrap()
                    == 0
        })
        || input["duration"]
            .as_u64()
            .and_then(|n| spec["durationFrames"][n.to_string()].as_u64())
            .is_none_or(|capacity| match input.get("audioFrames") {
                Some(frames) => spec["runner"] != "musetalk-native" || frames != &input["frames"]
                    || frames.as_u64().is_none_or(|n| n > capacity),
                None => input["frames"] != capacity,
            })
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
                "所选模型仅支持声明的标准画布",
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
        let runtime = adapters::Status::new(&settings);
        let mut models = Vec::new();
        // Keep familiar models in the original order, then include native-only entries.
        let catalog = catalog::constants()["MODEL_CATALOG"].as_array().unwrap();
        let specs = adapters::manifest()["models"].as_object().unwrap();
        let existing = catalog.iter().filter_map(|item| item["id"].as_str());
        let extra = specs.keys().map(String::as_str).filter(|id| catalog::model(id).is_none());
        for id in existing.chain(extra) {
            let Some(spec) = specs.get(id).filter(|s| s["media"] == "video") else { continue };
            let mut status = runtime.model(id);
            status["executable"] = json!(true);
            status["durations"] = json!([2, 3, 5, 10, 15].into_iter().filter(|s| spec["durationFrames"].get(s.to_string()).is_some()).collect::<Vec<_>>());
            status["qualities"] = if spec["canvases"].is_object() { json!(["standard"]) } else { json!(["fast", "standard", "fine"]) };
            status["supportsNegative"] = spec["negative"].clone();
            status["supportsGeneratedAudio"] = json!(prompt_compiler::supports_audio(spec));
            if spec["runner"] == "musetalk-native" {
                status["supportsGeneratedAudio"] = json!(false);
            }
            for key in ["drivingInput", "attentionModes"] {
                if let Some(value) = spec.get(key) {
                    status[key] = value.clone();
                }
            }
            let reason = status["unavailableReason"].as_str().unwrap_or("").to_owned();
            status["reason"] = json!(reason);
            status["tier"] = json!(if status["available"] == true { "本机文件就绪" } else { "待准备" });
            status["summary"] = json!(match spec["drivingInput"].as_str() {
                Some("video") => "让角色跟随参考视频的动作",
                Some("audio") => "让角色跟随配音说话",
                _ if spec["audio"] == true => "原生生成视频与音轨",
                _ => "原生生成无声视频",
            });
            status["remaining"] = adapters::manifest()["pendingVideo"][id].clone();
            if id == "minimax-h3"
                && let Some(pack) = local_pack(&settings.models_root.join(id))
            {
                let steps = &pack.steps;
                status["h3LightVae"] = json!(pack.lightvae);
                status["attentionModes"] = json!(spec["localPack"]["attentionModes"].as_array().unwrap()
                    .iter().filter(|mode| (**mode != "h3-sla" || pack.sla) && (**mode != "h3-fused" || pack.fused)).collect::<Vec<_>>());
                if let Some(label) = spec["localPack"]["label"].as_str() {
                    status["label"] = json!(label);
                }
                status["defaults"]["steps"] = json!(steps[0]);
                status["summary"] = json!(if steps.contains(&8) { "原生音视频，可选 4 步或 8 步" } else { "原生音视频，4 步生成" });
                status["turboSteps"] = json!(steps);
            }
            if spec["runner"] == "wan-a14b-sd" {
                status["summary"] = json!("单张首帧或首尾帧，双专家 LightX2V，分块视频解码");
                status["turboSteps"] = spec["stepOptions"].clone();
                status["resolutions"] = json!([480,720]);
            }
            let environment = match spec["runner"].as_str() {
                Some("longcat-avatar") => "LongCat-Avatar 独立环境与官方源码",
                Some("wan-a14b-sd") => "sd.cpp CUDA 原生视频执行器",
                _ => "独立 adapters Python 环境",
            };
            status["requirements"] = json!([environment, format!("{id}/ 完整模型目录"), "本机 ffmpeg"]);
            status["missing"] = if status["available"] == true { json!([]) } else { json!([reason]) };
            models.push(status);
        }
        models
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
            json!({"id":id,"label":q["label"],"summary":"","sizes":sizes})
        })
        .collect::<Vec<_>>();
    let default = models.iter().find(|model| {
        model["available"] == true && model["modes"].as_array()
            .is_some_and(|modes| modes.iter().any(|mode| mode == "text"))
    }).or_else(|| models.iter().find(|model| model["id"] == "wan2.2-ti2v-5b"))
      .ok_or_else(|| error(503, "NATIVE_STATUS_UNAVAILABLE", "缺少原生视频模型清单"))?;
    Ok(
        json!({"engine":"native","provider":"native","readiness":"files-only","validation":"待主力机验证",
        "online":models.iter().any(|m| m["available"]==true),"models":models,"pending":backend.pending(),"maxPending":generation::native::MAX_PENDING,
        "defaults":{"modelId":default["id"],"aspectRatio":"landscape","duration":default["durations"][0],"camera":"still","motion":"subtle","quality":"standard","steps":default["defaults"]["steps"]},
        "qualities":qualities,"t8":{"available":false,"reason":"原生适配未接入 H3 T8"}}),
    )
}
