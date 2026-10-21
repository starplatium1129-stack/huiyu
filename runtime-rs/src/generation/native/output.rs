use super::*;
use std::path::Path;

pub(super) fn anima_request(
    job: &Job,
    plan: &Plan,
    output: &Path,
    image: Option<PathBuf>,
    mask: Option<PathBuf>,
    sketch: Option<PathBuf>,
) -> Value {
    let mut input = json!({"negativePrompt":plan.input["negative"]});
    for key in [
        "prompt",
        "width",
        "height",
        "steps",
        "cfg",
        "seed",
        "family",
        "sampler",
        "scheduler",
        "teaCache",
        "hiresFix",
        "hiresScale",
        "hiresDenoise",
        "hiresUpscaler",
        "superResModel",
        "hiresSampler",
        "hiresScheduler",
        "rcasStrength",
    ] {
        input[key] = plan.input[key].clone();
    }
    for key in ["sketchControl", "regions"] {
        if let Some(value) = plan.input.get(key) { input[key] = value.clone(); }
    }
    input["teaCacheAuto"] = json!(plan.input["teaCacheAuto"] == true);
    if let Some(threshold) = plan.input.get("teaCacheThresh") {
        input["teaCacheThresh"] = threshold.clone();
    }
    if image.is_some() {
        input["denoisingStrength"] = plan.input["denoisingStrength"].clone();
    }
    if plan.mask_model_dir.is_some() {
        for key in ["maskPrompt", "maskThreshold", "growMaskBy"] {
            input[key] = plan.input[key].clone();
        }
    }
    if mask.is_some() {
        input["growMaskBy"] = plan.input["growMaskBy"].clone();
    }
    let mut request = json!({"id":job.id,"op":"generate","modelDir":plan.model_dir,"maskModelDir":plan.mask_model_dir,"upscaleModelPath":plan.upscale_model_path,"outputPath":output,"input":null,"inputImagePath":image,"maskImagePath":mask,"loras":plan.loras});
    request["input"] = input;
    if let Some(path) = sketch { request["sketchImagePath"] = json!(path); }
    if let Some(path) = &plan.sketch_model_path { request["sketchModelPath"] = json!(path); }
    request
}

pub(super) fn manga_request(
    job: &Job,
    plan: &Plan,
    output: &Path,
    image: Option<PathBuf>,
    pen: Option<PathBuf>,
) -> Value {
    let input = [
        "operation",
        "levels",
        "finish",
        "panel",
        "rewrite",
        "autoLines",
        "penLinesPolarity",
        "penLinesFit",
    ]
    .iter()
    .filter_map(|key| plan.input.get(*key).map(|v| ((*key).to_owned(), v.clone())))
    .collect::<serde_json::Map<_, _>>();
    let mut request = json!({"id":job.id,"op":"generate","outputPath":output,"input":null,"inputImagePath":image,"penLinesPath":pen,
        "lineartOutputPath":if manga::has_lines(&plan.input){json!(manga::lineart_path(output, &plan.input))}else{Value::Null},
        "modelDir":if plan.input["rewrite"].is_object(){json!(plan.model_dir)}else{Value::Null},
        "lineartPath":if plan.input["autoLines"]==true{json!(plan.settings.models_root.join("manga-line-extraction/erika.pth"))}else{Value::Null}});
    request["input"] = Value::Object(input);
    request
}
// Called only after full PNG decoder admission. Dimensions describe the actual
// cropped/framed result, not the upload or an assumed diffusion canvas.
pub(super) async fn png_dimensions(path: &Path) -> Result<(u32, u32)> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || -> Result<_> {
        use std::io::Read;
        let mut header = [0; 24];
        std::fs::File::open(path)?.read_exact(&mut header)?;
        Ok((
            u32::from_be_bytes(header[16..20].try_into().unwrap()),
            u32::from_be_bytes(header[20..24].try_into().unwrap()),
        ))
    })
    .await
    .map_err(|error| ApiError::from(std::io::Error::other(error)))?
}

pub(super) fn adapter_request(
    job: &Job,
    plan: &Plan,
    output: &Path,
    image: Option<PathBuf>,
) -> Value {
    let mut input = json!({"negativePrompt":plan.input["negative"]});
    for key in [
        "modelId", "prompt", "width", "height", "steps", "cfg", "seed",
    ] {
        input[key] = plan.input[key].clone();
    }
    if plan.input["mediaKind"] == "video" {
        input["frames"] = plan.input["frames"].clone();
        input["fps"] = plan.input["fps"].clone();
    }
    if let Some(trigger) = plan.input["styleLoraTrigger"].as_str() {
        input["prompt"] = json!(format!("{}, {}", plan.input["prompt"].as_str().unwrap_or(""), trigger));
    }
    let mut request = json!({"id":job.id,"op":"generate","modelDir":plan.model_dir,"outputPath":output,"input":null,"inputImagePath":image});
    if !plan.loras.is_empty() { request["loras"] = json!(plan.loras); }
    request["input"] = input;
    request
}
pub(super) async fn validate(path: &Path, video: bool, cancel: &CancellationToken) -> Result<()> {
    if video {
        // Match the existing video boundary: bounded MP4 container, not an
        // assertion of visual/audio quality or real model correctness.
        let mut file = tokio::fs::File::open(path).await?;
        let mut header = [0; 12];
        file.read_exact(&mut header).await?;
        if &header[4..8] != b"ftyp" {
            return Err(protocol_error());
        }
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "ABORT_ERR", "视频保存已取消"));
        }
        Ok(())
    } else {
        crate::image_decode::validate_png_file(path.to_owned(), cancel).await
    }
}

pub(super) fn stage_text(event: &Value) -> Result<String> {
    let label = match event["stage"].as_str() {
        Some("dependencies") => "准备推理环境",
        Some("fingerprint") => "确认模型与 LoRA",
        Some("preparing_image") => "处理输入图像",
        Some("loading") => "加载模型",
        Some("uploading") => "传输模型到显卡",
        Some("adapters") => "应用 LoRA",
        Some("encoding") => "编码提示词",
        Some("sampling") => "采样",
        Some("decoding") => "解码生成内容",
        Some("upscaling") => "放大图像",
        Some("saving") => "保存生成内容",
        Some("manga_rewrite") => "Qwen 漫画重绘",
        Some("manga_line_loading") => "加载自动线稿模型",
        Some("manga_line_extract") => "自动提取漫画线稿",
        Some("manga_line_saving") => "保存独立线稿",
        Some("manga_levels") => "漫画灰度与色阶",
        Some("manga_lines") => "分离漫画线条",
        Some("manga_values") => "整理漫画明暗",
        Some("manga_tones") => "规划漫画色块",
        Some("manga_screen") => "绘制漫画网点",
        Some("manga_panel") => "漫画裁框与纸张",
        _ => return Err(protocol_error()),
    };
    let component = match event.get("component").and_then(Value::as_str) {
        None => "",
        Some("text_encoder") => " · 文本编码器",
        Some("text_encoder_2") => " · 第二文本编码器",
        Some("text_conditioner") => " · 文本条件模型",
        Some("transformer") => " · 扩散模型",
        Some("vae") => " · VAE",
        Some("audio_vae") => " · 音频 VAE",
        Some("processor") => " · 多模态处理器",
        Some("tokenizer" | "t5_tokenizer") => " · 分词器",
        Some("scheduler") => " · 调度器",
        Some("audio_scheduler") => " · 音频调度器",
        Some(_) => return Err(protocol_error()),
    };
    Ok(format!("独立推理{label}{component}"))
}
