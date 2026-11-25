mod clean;
pub(crate) use clean::fusion_scene_is_wardrobe_free;
mod compile;
mod custom_actor;
mod input;
mod layout_bind;
mod ref_layout;
mod resolve;
mod scene_reference;
mod studio;

use super::*;
use clean::{
    CastFormation, clean_cast_prose, clean_moss_reference_prose, count_tags_by_gender,
    is_cast_count_tag, is_wardrobe_token, normalize_key, unique_tags,
};
use compile::{CompileContext, compile_family_prompt};
use input::{MAX_ACTION_CHARS, MAX_CAST_MEMBERS, MAX_OUTFIT_PROMPT_CHARS, validate_member_bbox};
use layout_bind::reference_performance;
use ref_layout::{parse_reference_layout, reference_people};
use resolve::{resolve_popular_actor, resolve_scene_context};
use std::collections::HashSet;

pub(super) use input::{CastMemberInput, InteractionInput};

pub(super) fn fusion_cast_members(members: &[CastMemberInput]) -> Vec<crate::interrogate::fuse::FuseCastMember> {
    members.iter().map(|member| crate::interrogate::fuse::FuseCastMember {
        action: member.action.clone().unwrap_or_default(),
        ..Default::default()
    }).collect()
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
    pub(super) bbox: Option<[f64; 4]>,
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
        .ok_or_else(|| {
            ApiError::invalid("cast 须包含 1–5 名角色；排布、互动和反推参考字段须搭配 cast 使用")
        })?;
    if raw_cast.len() > MAX_CAST_MEMBERS {
        return Err(ApiError::invalid("同框阵容最多支持 5 名角色"));
    }
    let interaction_clean = match input.interaction.as_ref() {
        Some(raw) => clean_cast_prose(&raw.normalize()?),
        None => String::new(),
    };
    let formation = match input.formation.as_deref() {
        Some(raw) => CastFormation::parse(Some(raw))?,
        None if !interaction_clean.is_empty() && (2..=3).contains(&raw_cast.len()) => {
            CastFormation::Close
        }
        None => CastFormation::Row,
    };

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
    if raw_cast.iter().any(|m| m.bbox.is_some()) && family != "moss-image" {
        return Err(ApiError::invalid("cast 成员的自定义 bbox 仅适用于 MOSS 图像模型"));
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

    let parsed_ref_layout = match input.layout.as_ref().or(input.reference_layout.as_ref()) {
        Some(layout_value) => Some(parse_reference_layout(layout_value, width, height)?),
        None => None,
    };
    let ref_people = reference_people(parsed_ref_layout.as_ref());
    let ref_char_count = ref_people.len();
    let inherit_ref_outfit = family == "moss-image" && ref_char_count >= raw_cast.len();
    let source_identity = input.reference_identity_terms.as_deref().unwrap_or_default();
    let raw_reference_tags = input.reference_tags.as_deref().unwrap_or_default();
    let count_tags: HashSet<String> = raw_reference_tags.iter()
        .filter(|tag| is_cast_count_tag(tag)).map(|tag| normalize_key(tag)).collect();
    let single_count = count_tags.iter().filter(|tag| tag.as_str() != "solo").count() <= 1
        && count_tags.iter().all(|tag| tag == "solo" || matches!(
            tag.replace(' ', "").as_str(), "1girl" | "1boy" | "1person" | "1woman" | "1man"
        ));
    let mut single_outfit = String::new();
    if raw_cast.len() > 1 && ref_char_count < 2
        && parsed_ref_layout.as_ref().is_none_or(|layout| layout.canvas == "single")
    {
        if let Some(person) = ref_people.first() {
            single_outfit = reference_performance(person, source_identity).0;
        }
        if single_outfit.is_empty() && single_count && (ref_char_count == 1 || !count_tags.is_empty()) {
            single_outfit = unique_tags(raw_reference_tags.iter()
                .filter(|tag| is_wardrobe_token(tag)).map(|tag| normalize_key(tag))).join(", ");
        }
    }

    let mut seen_keys = HashSet::new();
    let mut actors = Vec::with_capacity(raw_cast.len());
    for (index, supplied_member) in raw_cast.iter().enumerate() {
        let mut effective = supplied_member.clone();
        let (mapped_clothing, mapped_pose) = if raw_cast.len() > 1 && ref_char_count > 1 {
            ref_people.get(index).map(|item| reference_performance(item, source_identity)).unwrap_or_default()
        } else if supplied_member.outfit_id.as_deref().is_some_and(|id| id.trim().eq_ignore_ascii_case("custom"))
            || supplied_member.outfit_prompt.as_deref().is_some_and(|value| !value.trim().is_empty())
        {
            (single_outfit.clone(), String::new())
        } else {
            (String::new(), String::new())
        };
        if !mapped_clothing.is_empty() {
            let text = mapped_clothing.strip_prefix("wearing ").unwrap_or(&mapped_clothing);
            effective.outfit_prompt = Some(text.chars().take(MAX_OUTFIT_PROMPT_CHARS).collect::<String>().trim_end_matches([',', ' ']).to_owned());
            effective.outfit_id = None;
            effective.outfit_explicit = Some(true);
        }
        let member = &effective;
        let raw_id = member.character_id.as_deref().unwrap_or("custom").trim();
        if raw_id.is_empty() || raw_id.chars().count() > 160 || raw_id.chars().any(char::is_control)
        {
            return Err(ApiError::invalid("cast 成员的 characterId 须为 1–160 个有效字符"));
        }
        if let Some(custom_outfit) = supplied_member.outfit_prompt.as_deref()
            && custom_outfit.chars().count() > MAX_OUTFIT_PROMPT_CHARS
        {
            return Err(ApiError::invalid(format!(
                "cast 成员的 outfitPrompt 不能超过 {MAX_OUTFIT_PROMPT_CHARS} 字"
            )));
        }
        let bbox = match member.bbox {
            Some(box4) => Some(validate_member_bbox(box4, raw_id)?),
            None => None,
        };
        let mut action = member
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
        if family == "anima" && action.is_empty() {
            action = mapped_pose;
        }
        let actor = if member.is_custom() {
            custom_actor::resolve_custom_actor(member, index, action, bbox)?
        } else if let Some(studio_id) = studio::studio_character_id(raw_id) {
            studio::resolve_studio_actor(
                studio_id,
                member.outfit_id.as_deref(),
                member.outfit_prompt.as_deref(),
                member.outfit_explicit,
                action,
                bbox,
                wardrobe_db.as_ref(),
            )?
        } else {
            resolve_popular_actor(
                &catalog,
                raw_id,
                member.outfit_id.as_deref(),
                member.outfit_prompt.as_deref(),
                member.outfit_explicit,
                action,
                bbox,
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
    identity_terms.extend(input.reference_identity_terms.iter().flatten().cloned());
    let local_keys: HashSet<String> = identity_terms
        .iter()
        .chain(actors.iter().flat_map(|a| a.identity_tokens.iter()))
        .chain(actors.iter().flat_map(|a| a.outfit_tokens.iter()))
        .map(|t| normalize_key(t))
        .collect();

    let reference_scene_tags = scene_reference::tags(
        input.reference_tags.as_deref().unwrap_or_default(),
        &local_keys,
    );
    let scene_tags = scene_ctx
        .as_ref()
        .map(|ctx| {
            unique_tags(ctx.tags.iter().cloned().filter(|token| {
                let key = normalize_key(token);
                !key.is_empty() && !local_keys.contains(&key) && !is_wardrobe_token(token)
            }))
        })
        .unwrap_or_default();
    let shared_scene_tags = unique_tags(scene_tags.into_iter().chain(reference_scene_tags.iter().cloned()));

    let user_prompt_clean = input
        .prompt
        .as_deref()
        .map(clean_cast_prose)
        .unwrap_or_default();
    let scene_prose_clean = scene_ctx
        .as_ref()
        .map(|ctx| clean_cast_prose(&clean_moss_reference_prose(&ctx.prose, &identity_terms, true)))
        .unwrap_or_default();
    let ref_from_layout = parsed_ref_layout
        .as_ref()
        .map(|layout| {
            if let Some(scene) = layout.scene.as_deref() {
                if actors.len() > 1 {
                    scene_reference::caption(scene, &identity_terms)
                } else {
                    clean_cast_prose(&clean_moss_reference_prose(scene, &identity_terms, true))
                }
            } else if let Some(text) = layout.summary_caption.as_deref() {
                if actors.len() > 1 {
                    scene_reference::caption(text, &identity_terms)
                } else {
                    clean_cast_prose(&clean_moss_reference_prose(text, &identity_terms, true))
                }
            } else {
                String::new()
            }
        })
        .unwrap_or_default();
    let has_structured_scene = parsed_ref_layout.as_ref().and_then(|l| l.scene.as_ref()).is_some();
    let ref_from_caption = if has_structured_scene {
        String::new()
    } else {
        input
            .reference_caption
            .as_deref()
            .map(|text| {
                if actors.len() > 1 || family != "moss-image" {
                    scene_reference::caption(text, &identity_terms)
                } else {
                    clean_cast_prose(&clean_moss_reference_prose(text, &identity_terms, true))
                }
            })
            .unwrap_or_default()
    };
    let ref_caption_clean = unique_tags([ref_from_caption, ref_from_layout]).join(" ");

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
        reference_scene_tags: &reference_scene_tags,
        count_tags: &count_tags,
        user_prompt_clean: &user_prompt_clean,
        interaction_clean: &interaction_clean,
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
