mod clean;
mod compile;
mod layout_bind;
mod ref_layout;
mod resolve;
mod studio;

use super::*;
use clean::{
    CastFormation, clean_cast_prose, clean_moss_reference_prose, count_tags_by_gender,
    is_wardrobe_token, normalize_key, unique_tags,
};
use compile::{CompileContext, compile_family_prompt};
use ref_layout::parse_reference_layout;
use resolve::{resolve_popular_actor, resolve_scene_context};
use std::collections::HashSet;

const MAX_CAST_MEMBERS: usize = 5;
const MAX_ACTION_CHARS: usize = 240;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CastMemberInput {
    pub(super) character_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) outfit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) outfit_explicit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) action: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CastMemberObject {
    #[serde(alias = "character")]
    character_id: String,
    #[serde(default, alias = "outfit")]
    outfit_id: Option<String>,
    #[serde(default)]
    outfit_explicit: Option<bool>,
    #[serde(default)]
    action: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum CastMemberRepr {
    Shorthand(String),
    Object(CastMemberObject),
}

impl<'de> serde::Deserialize<'de> for CastMemberInput {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match CastMemberRepr::deserialize(deserializer)? {
            CastMemberRepr::Object(obj) => Ok(Self {
                character_id: obj.character_id,
                outfit_id: obj.outfit_id,
                outfit_explicit: obj.outfit_explicit,
                action: obj.action,
            }),
            CastMemberRepr::Shorthand(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    return Err(serde::de::Error::custom("cast 成员不能为空字符串"));
                }
                let Some((char_part, rest)) = trimmed.split_once(':') else {
                    return Ok(Self {
                        character_id: trimmed.to_owned(),
                        outfit_id: None,
                        outfit_explicit: None,
                        action: None,
                    });
                };
                let character_id = char_part.trim();
                if character_id.is_empty() {
                    return Err(serde::de::Error::custom(
                        "cast 简写缺少角色 ID，格式为 角色ID[:服装ID][:动作]",
                    ));
                }
                let (outfit_part, action_part) = match rest.split_once(':') {
                    Some((o, a)) => (o.trim(), a.trim()),
                    None => (rest.trim(), ""),
                };
                let outfit_id = (!outfit_part.is_empty()).then(|| outfit_part.to_owned());
                let outfit_explicit = outfit_id.as_ref().map(|_| true);
                let action = (!action_part.is_empty()).then(|| action_part.to_owned());
                Ok(Self {
                    character_id: character_id.to_owned(),
                    outfit_id,
                    outfit_explicit,
                    action,
                })
            }
        }
    }
}

pub(super) struct ResolvedActor {
    pub(super) key: String,
    pub(super) name: String,
    pub(super) character_tokens: Vec<String>,
    pub(super) copyright_tokens: Vec<String>,
    pub(super) aliases: Vec<String>,
    pub(super) identity_tokens: Vec<String>,
    pub(super) outfit_tokens: Vec<String>,
    pub(super) identity_caption: String,
    pub(super) outfit_caption: String,
    pub(super) outfit_explicit: bool,
    pub(super) action: String,
    pub(super) gender: &'static str,
}

#[derive(Default)]
pub(super) struct SceneContext {
    pub(super) recommended_size: Option<(u64, u64)>,
    pub(super) prose: String,
    pub(super) tags: Vec<String>,
    pub(super) camera: String,
    pub(super) source_identity_terms: Vec<String>,
}

pub(super) fn parse_size(raw: &str) -> Option<(u64, u64)> {
    let normalized = raw.replace('×', "x");
    let (w, h) = normalized.split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

fn closest_size(spec: &Value, desired: Option<(u64, u64)>) -> Option<(u64, u64)> {
    let sizes: Vec<(u64, u64)> = spec["sizes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(parse_size)
        .collect();
    if sizes.is_empty() {
        return None;
    }
    let Some((target_w, target_h)) = desired.filter(|(w, h)| *w > 0 && *h > 0) else {
        return Some(sizes[0]);
    };
    let target_ratio = target_w as f64 / target_h as f64;
    sizes.into_iter().min_by(|&(w1, h1), &(w2, h2)| {
        let d1 = ((w1 as f64 / h1 as f64) - target_ratio).abs();
        let d2 = ((w2 as f64 / h2 as f64) - target_ratio).abs();
        d1.total_cmp(&d2)
    })
}

pub(super) fn prepare(
    config: &crate::config::Config,
    input: SceneSelection,
    fallback: Option<&str>,
) -> Result<PreparedScene> {
    let model = input.model_id.as_deref().or(fallback).unwrap_or(ANIMA);
    if model == "manga-screen" || input.kind.as_deref() == Some("manga") || input.has_manga_fields()
    {
        return Err(ApiError::invalid("多角色同框（cast）不支持 manga-screen 漫画处理模式"));
    }
    if input.character.is_some()
        || input.lora_id.is_some()
        || input.lora_strength.is_some()
        || input.outfit_id.is_some()
    {
        return Err(ApiError::invalid(
            "使用 cast 多角色同框时请勿同时传单角色 character、loraId、loraStrength 或顶层 outfitId（服装请在每个 cast 成员内指定）",
        ));
    }

    let raw_cast = input
        .cast
        .as_ref()
        .filter(|list| !list.is_empty())
        .ok_or_else(|| ApiError::invalid("cast 须包含 1–5 名角色；formation 须搭配 cast 使用"))?;
    if raw_cast.len() > MAX_CAST_MEMBERS {
        return Err(ApiError::invalid("同框阵容最多支持 5 名角色"));
    }
    let formation = CastFormation::parse(input.formation.as_deref())?;

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
    if input.style_lora_id.is_some() && family != "krea2" {
        return Err(ApiError::invalid("styleLoraId 仅适用于 Krea 2"));
    }

    let (max_seed, variants) = submission::limits(&input, family)?;
    let catalog =
        crate::catalog::Catalog::open_readonly(crate::catalog::Options::from_config(config))?;
    let wardrobe_db = library::open_bundled_library(config).ok();

    let scene_ctx = match input.id.as_deref() {
        Some(id) => Some(resolve_scene_context(&catalog, input.kind.as_deref(), id)?),
        None => None,
    };

    let (width, height) = match submission::dimensions(input.width, input.height)? {
        Some(size) => size,
        None if matches!(family, "qwen-image" | "keyframe") => (1024, 1024),
        None => closest_size(spec, scene_ctx.as_ref().and_then(|ctx| ctx.recommended_size))
            .ok_or_else(|| ApiError::invalid("此模型需要显式指定 width 和 height"))?,
    };

    let parsed_ref_layout = match input.layout.as_ref() {
        Some(layout_value) => Some(parse_reference_layout(layout_value, width, height)?),
        None => None,
    };
    let ref_char_count = parsed_ref_layout
        .as_ref()
        .map(|layout| {
            layout
                .items
                .iter()
                .filter(|item| item.label == "character")
                .count()
        })
        .unwrap_or(0);
    let inherit_ref_outfit = family == "moss-image" && ref_char_count >= raw_cast.len();

    let mut seen_keys = HashSet::new();
    let mut actors = Vec::with_capacity(raw_cast.len());
    for member in raw_cast {
        let raw_id = member.character_id.trim();
        if raw_id.is_empty() || raw_id.chars().count() > 160 || raw_id.chars().any(char::is_control)
        {
            return Err(ApiError::invalid("cast 成员的 characterId 须为 1–160 个有效字符"));
        }
        let action = member
            .action
            .as_deref()
            .map(|text| {
                clean_cast_prose(
                    &text
                        .replace(['\r', '\n'], " ")
                        .trim()
                        .chars()
                        .take(MAX_ACTION_CHARS)
                        .collect::<String>(),
                )
            })
            .unwrap_or_default();
        let actor = if let Some(studio_id) = studio::studio_character_id(raw_id) {
            studio::resolve_studio_actor(
                studio_id,
                member.outfit_id.as_deref(),
                member.outfit_explicit,
                action,
                wardrobe_db.as_ref(),
            )?
        } else {
            resolve_popular_actor(
                &catalog,
                raw_id,
                member.outfit_id.as_deref(),
                member.outfit_explicit,
                action,
                inherit_ref_outfit,
            )?
        };
        if !seen_keys.insert(actor.key.clone()) {
            return Err(ApiError::invalid(format!(
                "cast 中存在重复角色：{}",
                actor.name
            )));
        }
        actors.push(actor);
    }

    let mut identity_terms: Vec<String> = actors
        .iter()
        .flat_map(|actor| actor.aliases.iter().cloned())
        .collect();
    if let Some(ctx) = &scene_ctx {
        identity_terms.extend(ctx.source_identity_terms.iter().cloned());
    }
    let local_keys: HashSet<String> = identity_terms
        .iter()
        .chain(actors.iter().flat_map(|a| a.identity_tokens.iter()))
        .chain(actors.iter().flat_map(|a| a.outfit_tokens.iter()))
        .map(|t| normalize_key(t))
        .collect();

    let shared_scene_tags: Vec<String> = scene_ctx
        .as_ref()
        .map(|ctx| {
            unique_tags(ctx.tags.iter().cloned().filter(|token| {
                let key = normalize_key(token);
                !key.is_empty() && !local_keys.contains(&key) && !is_wardrobe_token(token)
            }))
        })
        .unwrap_or_default();

    let user_prompt_clean = input
        .prompt
        .as_deref()
        .map(clean_cast_prose)
        .unwrap_or_default();
    let scene_prose_clean = scene_ctx
        .as_ref()
        .map(|ctx| clean_cast_prose(&clean_moss_reference_prose(&ctx.prose, &identity_terms, true)))
        .unwrap_or_default();
    let ref_caption_clean = parsed_ref_layout
        .as_ref()
        .and_then(|layout| layout.summary_caption.as_deref())
        .map(|text| clean_cast_prose(&clean_moss_reference_prose(text, &identity_terms, true)))
        .unwrap_or_default();

    let genders: Vec<&str> = actors.iter().map(|a| a.gender).collect();
    let count_tags = count_tags_by_gender(&genders);

    let (resolved_prompt, default_negative) = compile_family_prompt(&CompileContext {
        family,
        width,
        height,
        formation,
        actors: &actors,
        scene_ctx: scene_ctx.as_ref(),
        parsed_ref_layout: parsed_ref_layout.as_ref(),
        identity_terms: &identity_terms,
        shared_scene_tags: &shared_scene_tags,
        count_tags: &count_tags,
        user_prompt_clean: &user_prompt_clean,
        scene_prose_clean: &scene_prose_clean,
        ref_caption_clean: &ref_caption_clean,
        user_negative: input.negative.as_deref(),
    })?;

    let mut payload = json!({
        "modelId": model,
        "prompt": resolved_prompt,
        "width": width,
        "height": height,
    });
    if family == "krea2" {
        if let Some(steps) = spec.get("steps").filter(|v| !v.is_null()) {
            payload["steps"] = steps.clone();
        }
        if let Some(cfg) = spec.get("cfg").filter(|v| !v.is_null()) {
            payload["cfg"] = cfg.clone();
        }
    }
    input.apply_tea_cache_options(&mut payload, family)?;
    input.apply_moss_options(&mut payload, family)?;
    input.apply_edit_options(&mut payload, family)?;
    submission::apply_upscale(&mut payload, family, input.upscale)?;
    if let Some(neg) = default_negative.filter(|text| !text.trim().is_empty()) {
        payload["negative"] = json!(neg);
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
    submission::prepare_payload(&mut payload, family)?;

    Ok(PreparedScene {
        kind: "cast".into(),
        id: input.id.unwrap_or_else(|| "cast".into()),
        family,
        model_id: model.to_owned(),
        payload,
        seed: input.seed,
        max_seed,
        variants,
    })
}
