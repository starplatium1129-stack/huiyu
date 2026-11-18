use super::*;

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
}

impl SceneSelection {
    pub(super) fn is_custom(&self) -> bool {
        self.prompt.is_some() || self.kind.as_deref() == Some("prompt")
    }

    pub(super) fn uses_raw_fields(&self) -> bool {
        self.negative.is_some()
            || self.width.is_some()
            || self.height.is_some()
            || self.steps.is_some()
            || self.cfg.is_some()
            || self.character.is_some()
            || self.lora_id.is_some()
            || self.lora_strength.is_some()
            || self.style_lora_id.is_some()
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

pub(super) fn custom(
    input: SceneSelection,
    fallback: Option<&str>,
    loras: &std::path::Path,
) -> Result<PreparedScene> {
    if input.id.is_some()
        || input.outfit_id.is_some()
        || input.kind.as_deref().is_some_and(|kind| kind != "prompt")
    {
        return Err(ApiError::invalid(
            "自定义 prompt 和目录 ID 请分成独立提交项",
        ));
    }
    let model = input.model_id.as_deref().or(fallback).unwrap_or(ANIMA);
    let adapter =
        generation::native::adapters::model(model).filter(|spec| spec["media"] == "image");
    let spec = match adapter {
        Some(spec) => spec,
        None => catalog::model(model)?,
    };
    let family = match spec["family"].as_str() {
        Some(family @ ("anima" | "krea2" | "qwen-image" | "moss-image")) => family,
        _ => return Err(ApiError::invalid("请选择已配置的原生图像模型")),
    };
    let (max_seed, variants) = limits(&input, family)?;
    let (width, height) = match (input.width, input.height) {
        (Some(width), Some(height)) => (width, height),
        (None, None) if family == "qwen-image" => (1024, 1024),
        (None, None) => spec["sizes"][0]
            .as_str()
            .and_then(|size| size.split_once('x'))
            .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
            .ok_or_else(|| ApiError::invalid("此模型需要显式指定 width 和 height"))?,
        _ => return Err(ApiError::invalid("width 和 height 必须一起指定")),
    };
    let mut payload = json!({"modelId":model,"prompt":input.prompt,"width":width,"height":height});
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
    if adapter.is_some() {
        native_adapters::validate(&payload, family)?;
    } else {
        validate(&payload, family)?;
    }
    Ok(PreparedScene {
        kind: "prompt".into(),
        id: "prompt".into(),
        family,
        payload,
        seed: input.seed,
        max_seed,
        variants,
    })
}
