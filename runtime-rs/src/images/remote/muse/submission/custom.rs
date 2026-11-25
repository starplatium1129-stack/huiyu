use super::super::*;
use super::{
    SceneSelection, apply_upscale, dimensions, limits, options::check_uploaded_name,
    prepare_payload,
};

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
        || input.cast.is_some()
        || input.formation.is_some()
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
