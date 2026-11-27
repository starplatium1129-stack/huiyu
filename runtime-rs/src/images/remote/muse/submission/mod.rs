mod custom;
mod options;

use super::*;

const MOSS_PREVIEW_SETTINGS: [&str; 4] =
    ["steps", "cfg", "mossAcceleration", "mossSpectrumFlexWindow"];

pub(super) use options::apply_upscale;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) style_lora_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) style_loras: Option<Vec<krea_styles::Style>>,
    // Multi-character cast composition (1–5 studio, popular or original characters)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cast: Option<Vec<cast::CastMemberInput>>,
    #[serde(skip_serializing_if = "Option::is_none", alias = "castFormation")]
    pub(super) formation: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        alias = "sceneInteraction",
        alias = "relations",
        alias = "relation"
    )]
    pub(super) interaction: Option<cast::InteractionInput>,
    // Keep extracted reference material separate from the author's prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_layout: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reference_identity_terms: Option<Vec<String>>,
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
            if scene.has_cast() {
                return cast::prepare(config, scene, model);
            }
            if scene.is_custom() {
                return custom::custom(scene, model, &loras);
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
