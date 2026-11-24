use super::*;

const MOSS_PREVIEW_SETTINGS: [&str; 4] =
    ["steps", "cfg", "mossAcceleration", "mossSpectrumFlexWindow"];

#[derive(Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SceneSelection {
    pub(super) kind: Option<String>,
    pub(super) id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) outfit_id: Option<String>,
    pub(super) model_id: Option<String>,
    pub(super) seed: Option<u64>,
    pub(super) variants: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) negative: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) width: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) height: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) upscale: Option<Upscale>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tea_cache: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tea_cache_thresh: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) moss_sampler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) moss_acceleration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) moss_spectrum_flex_window: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) steps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cfg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) character: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) lora_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) lora_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) style_lora_id: Option<String>,
    // Image-to-image / inpaint / reference / composition parameters
    #[serde(skip_serializing_if = "Option::is_none", alias = "imageId")]
    pub(super) init_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_images: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) denoising_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mask_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mask_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mask_threshold: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) grow_mask_by: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) sketch_control: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) regions: Option<Vec<Value>>,
    // MOSS structured layout (accepts assistLayout, normalized 0..1, abs/xyxy, or abs_centralized/yxyx)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) layout: Option<Value>,
    // MangaScreen parameters (when modelId == "manga-screen" or kind == "manga")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pen_lines: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pen_lines_polarity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pen_lines_fit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) auto_lines: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) levels: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) finish: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) panel: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) rewrite: Option<Value>,
}

#[derive(Clone, Copy, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Upscale {
    Off,
    UltraSharp,
    Remacri,
}

pub(super) fn apply_upscale(
    payload: &mut Value,
    family: &str,
    upscale: Option<Upscale>,
) -> Result<()> {
    let Some(upscale) = upscale else {
        return Ok(());
    };
    let name = match upscale {
        Upscale::Off => {
            if family == "anima" {
                payload["hiresFix"] = json!(false);
            }
            return Ok(());
        }
        Upscale::UltraSharp => "4x-UltraSharp",
        Upscale::Remacri => "Remacri",
    };
    if family != "anima" {
        return Err(ApiError::invalid(
            "UltraSharp 和 Remacri 随出图放大仅适用于 Anima",
        ));
    }
    payload["hiresFix"] = json!(true);
    payload["hiresUpscaler"] = json!(name);
    payload["hiresScale"] = json!(1.5);
    // The native Anima backend uses Euler/Normal with shift 3 for UltraSharp.
    payload["hiresDenoise"] = json!(0.8);
    payload["hiresSteps"] = json!(10);
    payload["hiresCfg"] = json!(5.5);
    Ok(())
}

fn check_uploaded_name(name: &str, field: &str) -> Result<()> {
    if !inputs::valid_name(name) {
        return Err(ApiError::invalid(format!(
            "{field} 必须是 /api/{{family}}/images/raw 返回的有效已上传图像名称"
        )));
    }
    Ok(())
}

impl SceneSelection {
    pub(super) fn apply_tea_cache_options(&self, payload: &mut Value, family: &str) -> Result<()> {
        if self.tea_cache.is_none() && self.tea_cache_thresh.is_none() {
            return Ok(());
        }
        if family != "anima" {
            return Err(ApiError::invalid("TeaCache 开关和阈值仅适用于 Anima"));
        }
        if let Some(enabled) = self.tea_cache {
            payload["teaCache"] = json!(enabled);
        }
        if let Some(threshold) = self.tea_cache_thresh {
            payload["teaCacheThresh"] =
                validation::number(&json!(threshold), "teaCacheThresh", 0., 1., false)?;
        }
        Ok(())
    }

    pub(super) fn apply_moss_options(&self, payload: &mut Value, family: &str) -> Result<()> {
        if family != "moss-image"
            && (self.moss_sampler.is_some()
                || self.moss_acceleration.is_some()
                || self.moss_spectrum_flex_window.is_some())
        {
            return Err(ApiError::invalid(
                "仅 MOSS 可指定 mossSampler、mossAcceleration 和 mossSpectrumFlexWindow",
            ));
        }
        if let Some(sampler) = &self.moss_sampler {
            if sampler == "er-sde" && payload["mossSampler"] != "er-sde" {
                // Drop the bundled Euler preset. Explicit options are applied after this step.
                let fields = payload.as_object_mut().ok_or_else(unavailable)?;
                for key in MOSS_PREVIEW_SETTINGS {
                    fields.remove(key);
                }
            }
            payload["mossSampler"] = json!(sampler);
        }
        if let Some(acceleration) = &self.moss_acceleration {
            payload["mossAcceleration"] = json!(acceleration);
        }
        if let Some(window) = self.moss_spectrum_flex_window {
            payload["mossSpectrumFlexWindow"] = json!(window);
        }
        Ok(())
    }

    pub(super) fn has_edit_fields(&self) -> bool {
        self.init_image.is_some()
            || self.reference_images.is_some()
            || self.denoising_strength.is_some()
            || self.mask_image.is_some()
            || self.mask_prompt.is_some()
            || self.mask_threshold.is_some()
            || self.grow_mask_by.is_some()
            || self.sketch_control.is_some()
            || self.regions.is_some()
    }

    pub(super) fn has_manga_fields(&self) -> bool {
        self.operation.is_some()
            || self.pen_lines.is_some()
            || self.pen_lines_polarity.is_some()
            || self.pen_lines_fit.is_some()
            || self.auto_lines.is_some()
            || self.levels.is_some()
            || self.finish.is_some()
            || self.panel.is_some()
            || self.rewrite.is_some()
    }

    pub(super) fn apply_edit_options(&self, payload: &mut Value, family: &str) -> Result<()> {
        if !self.has_edit_fields() {
            return Ok(());
        }
        if let Some(init) = &self.init_image {
            if !matches!(family, "anima" | "qwen-image" | "keyframe") {
                return Err(ApiError::invalid(
                    "initImage 仅适用于 Anima、Qwen-Image 和 Keyframe 模型",
                ));
            }
            check_uploaded_name(init, "initImage")?;
            payload["initImage"] = json!(init);
        }
        if let Some(references) = &self.reference_images {
            if !matches!(family, "qwen-image" | "keyframe") {
                return Err(ApiError::invalid(
                    "referenceImages 仅适用于 Qwen-Image 和 Keyframe 模型",
                ));
            }
            for name in references {
                check_uploaded_name(name, "referenceImages")?;
            }
            payload["referenceImages"] = json!(references);
        }
        if self.denoising_strength.is_some()
            || self.mask_image.is_some()
            || self.mask_prompt.is_some()
            || self.mask_threshold.is_some()
            || self.grow_mask_by.is_some()
            || self.sketch_control.is_some()
            || self.regions.is_some()
        {
            if family != "anima" {
                return Err(ApiError::invalid(
                    "denoisingStrength、maskImage、maskPrompt、maskThreshold、growMaskBy、sketchControl 和 regions 仅适用于 Anima",
                ));
            }
            if let Some(strength) = self.denoising_strength {
                if self.init_image.is_none() {
                    return Err(ApiError::invalid("denoisingStrength 需要同时提供 initImage"));
                }
                payload["denoisingStrength"] = json!(strength);
            }
            if let Some(mask) = &self.mask_image {
                check_uploaded_name(mask, "maskImage")?;
                payload["maskImage"] = json!(mask);
            }
            if let Some(mask_prompt) = &self.mask_prompt {
                payload["maskPrompt"] = json!(mask_prompt);
            }
            if let Some(threshold) = self.mask_threshold {
                payload["maskThreshold"] = json!(threshold);
            }
            if let Some(grow) = self.grow_mask_by {
                payload["growMaskBy"] = json!(grow);
            }
            if let Some(sketch) = &self.sketch_control {
                if let Some(name) = sketch["image"].as_str() {
                    check_uploaded_name(name, "sketchControl.image")?;
                }
                payload["sketchControl"] = sketch.clone();
            }
            if let Some(regions) = &self.regions {
                payload["regions"] = json!(regions);
            }
        }
        Ok(())
    }

    pub(super) fn is_custom(&self) -> bool {
        self.prompt.is_some()
            || self.layout.is_some()
            || matches!(self.kind.as_deref(), Some("prompt" | "manga"))
            || self.model_id.as_deref() == Some("manga-screen")
    }

    pub(super) fn uses_prompt_only_fields(&self) -> bool {
        self.negative.is_some()
            || self.steps.is_some()
            || self.cfg.is_some()
            || self.character.is_some()
            || self.lora_id.is_some()
            || self.lora_strength.is_some()
            || self.layout.is_some()
            || self.reference_images.is_some()
            || self.has_manga_fields()
    }
}

pub(super) fn dimensions(width: Option<u64>, height: Option<u64>) -> Result<Option<(u64, u64)>> {
    match (width, height) {
        (Some(width), Some(height)) => Ok(Some((width, height))),
        (None, None) => Ok(None),
        _ => Err(ApiError::invalid("width 和 height 必须一起指定")),
    }
}

pub(super) fn prepare_batch(
    config: &crate::config::Config,
    loras: PathBuf,
    scenes: Vec<SceneSelection>,
    model: Option<&str>,
) -> Result<Vec<PreparedScene>> {
    let mut library = None;
    scenes
        .into_iter()
        .map(|scene| {
            if scene.is_custom() {
                return custom(scene, model, &loras);
            }
            let recipes = match &library {
                Some(recipes) => recipes,
                None => library.insert(RecipeLibrary::new(config, loras.clone())?),
            };
            recipes.prepare(scene, model)
        })
        .collect()
}

pub(super) fn limits(input: &SceneSelection, family: &str) -> Result<(u64, u8)> {
    let max_seed = if matches!(family, "anima" | "krea2") {
        MAX_SEED
    } else {
        2_147_483_647
    };
    if input.seed.is_some_and(|seed| seed > max_seed) {
        return Err(ApiError::invalid(format!("种子须为 0–{max_seed} 的整数")));
    }
    let variants = input.variants.unwrap_or(1);
    if !(1..=MAX_VARIANTS).contains(&variants) {
        return Err(ApiError::invalid("每项可请求 1–8 张变体"));
    }
    Ok((max_seed, variants))
}

fn prepare_manga(input: SceneSelection) -> Result<PreparedScene> {
    if input.id.is_some()
        || input.outfit_id.is_some()
        || input
            .kind
            .as_deref()
            .is_some_and(|kind| !matches!(kind, "manga" | "prompt"))
    {
        return Err(ApiError::invalid(
            "漫画化任务不能与目录 ID 混用，kind 可省略或设为 manga",
        ));
    }
    if input.prompt.is_some()
        || input.negative.is_some()
        || input.width.is_some()
        || input.height.is_some()
        || input.steps.is_some()
        || input.cfg.is_some()
        || input.seed.is_some()
        || input.upscale.is_some()
        || input.tea_cache.is_some()
        || input.tea_cache_thresh.is_some()
        || input.moss_sampler.is_some()
        || input.moss_acceleration.is_some()
        || input.moss_spectrum_flex_window.is_some()
        || input.character.is_some()
        || input.lora_id.is_some()
        || input.lora_strength.is_some()
        || input.style_lora_id.is_some()
        || input.layout.is_some()
        || input.reference_images.is_some()
        || input.denoising_strength.is_some()
        || input.mask_image.is_some()
        || input.mask_prompt.is_some()
        || input.mask_threshold.is_some()
        || input.grow_mask_by.is_some()
        || input.sketch_control.is_some()
        || input.regions.is_some()
    {
        return Err(ApiError::invalid(
            "manga-screen 仅接受 initImage、operation、penLines、penLinesPolarity、penLinesFit、autoLines、levels、finish、panel 和 rewrite",
        ));
    }
    if input.variants.unwrap_or(1) != 1 {
        return Err(ApiError::invalid("manga-screen 每次仅支持 1 张输出（variants=1）"));
    }
    let init = input
        .init_image
        .as_deref()
        .ok_or_else(|| ApiError::invalid("manga-screen 需要已上传的 initImage"))?;
    check_uploaded_name(init, "initImage")?;
    let mut payload = json!({ "initImage": init });
    if let Some(op) = &input.operation {
        payload["operation"] = json!(op);
    }
    if let Some(pen) = &input.pen_lines {
        check_uploaded_name(pen, "penLines")?;
        payload["penLines"] = json!(pen);
    }
    if let Some(polarity) = &input.pen_lines_polarity {
        payload["penLinesPolarity"] = json!(polarity);
    }
    if let Some(fit) = &input.pen_lines_fit {
        payload["penLinesFit"] = json!(fit);
    }
    if let Some(auto) = input.auto_lines {
        payload["autoLines"] = json!(auto);
    }
    if let Some(levels) = &input.levels {
        payload["levels"] = levels.clone();
    }
    if let Some(finish) = &input.finish {
        payload["finish"] = finish.clone();
    }
    if let Some(panel) = &input.panel {
        payload["panel"] = panel.clone();
    }
    if let Some(rewrite) = &input.rewrite {
        payload["rewrite"] = rewrite.clone();
    }
    manga::validate(&payload)?;
    Ok(PreparedScene {
        kind: "manga".into(),
        id: input.operation.unwrap_or_else(|| "lite".into()),
        family: "manga-screen",
        model_id: "manga-screen".into(),
        payload,
        seed: Some(0),
        max_seed: 2_147_483_647,
        variants: 1,
    })
}

pub(super) fn custom(
    input: SceneSelection,
    fallback: Option<&str>,
    loras: &std::path::Path,
) -> Result<PreparedScene> {
    let model = input.model_id.as_deref().or(fallback).unwrap_or(ANIMA);
    if model == "manga-screen" || input.kind.as_deref() == Some("manga") {
        if model != "manga-screen" && input.model_id.is_some() {
            return Err(ApiError::invalid("kind=manga 时 modelId 须为 manga-screen 或省略"));
        }
        return prepare_manga(input);
    }
    if input.has_manga_fields() {
        return Err(ApiError::invalid(
            "漫画处理参数（operation/penLines/levels/finish/panel/rewrite/autoLines）仅适用于 modelId=manga-screen",
        ));
    }
    if input.id.is_some()
        || input.outfit_id.is_some()
        || input.kind.as_deref().is_some_and(|kind| kind != "prompt")
    {
        return Err(ApiError::invalid(
            "自定义 prompt/layout 和目录 ID 请分成独立提交项",
        ));
    }
    let adapter = generation::native::adapters::model(model)
        .filter(|spec| spec["media"] == "image" && spec["packedManga"] != true);
    let spec = match adapter {
        Some(spec) => spec,
        None => catalog::model(model)?,
    };
    let family = match spec["family"].as_str() {
        Some(family @ ("anima" | "krea2" | "qwen-image" | "moss-image" | "keyframe")) => family,
        _ => return Err(ApiError::invalid("请选择已配置的原生图像模型")),
    };
    if input.layout.is_some() && family != "moss-image" {
        return Err(ApiError::invalid("layout 参数仅适用于 MOSS 图像模型"));
    }
    let (max_seed, variants) = limits(&input, family)?;
    let (width, height) = match dimensions(input.width, input.height)? {
        Some(size) => size,
        None if matches!(family, "qwen-image" | "keyframe") => (1024, 1024),
        None => spec["sizes"][0]
            .as_str()
            .and_then(|size| size.split_once('x'))
            .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
            .ok_or_else(|| ApiError::invalid("此模型需要显式指定 width 和 height"))?,
    };
    let resolved_prompt = if family == "moss-image" {
        layout::compile_custom_prompt(input.prompt.as_deref(), input.layout.as_ref(), width, height)?
    } else {
        input
            .prompt
            .as_deref()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| ApiError::invalid("请输入非空的 prompt"))?
            .to_owned()
    };
    let mut payload =
        json!({"modelId":model,"prompt":resolved_prompt,"width":width,"height":height});
    input.apply_tea_cache_options(&mut payload, family)?;
    input.apply_moss_options(&mut payload, family)?;
    input.apply_edit_options(&mut payload, family)?;
    apply_upscale(&mut payload, family, input.upscale)?;
    if let Some(value) = input.negative {
        payload["negative"] = json!(value);
    }
    if let Some(value) = input.steps {
        payload["steps"] = json!(value);
    }
    if let Some(value) = input.cfg {
        payload["cfg"] = json!(value);
    }
    if let Some(value) = input.style_lora_id {
        payload["styleLoraId"] = json!(value);
    }
    if input.character.is_some() || input.lora_id.is_some() || input.lora_strength.is_some() {
        if family != "anima" {
            return Err(ApiError::invalid("角色 LoRA 参数仅适用于 Anima"));
        }
        let character = input.character.as_deref().map(|name| match name {
            "宁宁" => "nene",
            "夏目" => "natsume",
            name => name,
        });
        let lora = input
            .lora_id
            .as_deref()
            .or_else(|| {
                character.and_then(|id| catalog::CATALOG["CHARACTERS"][id]["loraId"].as_str())
            })
            .ok_or_else(|| {
                ApiError::invalid("未找到角色默认 LoRA，请指定 loraId 或省略角色 LoRA 参数")
            })?;
        let binding =
            catalog::lora(lora).ok_or_else(|| ApiError::invalid("未知的 Anima LoRA ID"))?;
        let character = character
            .or_else(|| {
                binding["characters"].as_array().and_then(|entries| {
                    if entries.len() == 1 {
                        entries[0].as_str()
                    } else {
                        None
                    }
                })
            })
            .or_else(|| {
                binding["character"]
                    .as_str()
                    .filter(|id| catalog::CATALOG["CHARACTERS"][id]["loraId"] == lora)
            })
            .ok_or_else(|| ApiError::invalid("此 LoRA 包含多个角色，请同时传 character"))?;
        if !binding["file"]
            .as_str()
            .and_then(|file| generation::native::resources::file(loras, file, false))
            .is_some()
        {
            return Err(ApiError::new(
                409,
                "LORA_NOT_INSTALLED",
                "所选角色 LoRA 尚未装好，请在绘遇安装，或省略角色 LoRA 参数",
            ));
        }
        let strength = input.lora_strength.unwrap_or_else(|| {
            0.85_f64.clamp(
                binding["minStrength"].as_f64().unwrap_or(0.),
                binding["maxStrength"].as_f64().unwrap_or(1.),
            )
        });
        payload["character"] = json!(character);
        payload["loraId"] = json!(lora);
        payload["loraStrength"] = json!(strength);
    }
    // The normal family validator stays authoritative for prompts, dimensions,
    // options and known model/LoRA combinations.
    prepare_payload(&mut payload, family)?;
    Ok(PreparedScene {
        kind: "prompt".into(),
        id: "prompt".into(),
        family,
        model_id: model.to_owned(),
        payload,
        seed: input.seed,
        max_seed,
        variants,
    })
}

pub(super) fn prepare_payload(payload: &mut Value, family: &str) -> Result<()> {
    let validated = validate_payload(payload, family)?;
    if family == "moss-image" && payload["mossSampler"] == "er-sde" {
        // Freeze the resolved preview settings with the queued job.
        for key in MOSS_PREVIEW_SETTINGS {
            payload[key] = validated[key].clone();
        }
    }
    Ok(())
}

pub(super) fn validate_payload(payload: &Value, family: &str) -> Result<Value> {
    if family == "manga-screen" {
        return manga::validate(payload);
    }
    if generation::native::adapters::model(payload["modelId"].as_str().unwrap_or("")).is_some() {
        native_adapters::validate(payload, family)
    } else {
        let validated = validate(payload, family)?;
        if family == "anima" {
            native::normalize(payload, validated)
        } else {
            Ok(validated)
        }
    }
}
