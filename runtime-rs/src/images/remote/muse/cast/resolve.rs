use super::clean::{
    clean_cast_prose, identity_without_outfit, is_wardrobe_token, normalize_key, public_tags,
};
use super::input::{format_custom_outfit_caption, is_clear_outfit_sentinel};
use super::{ResolvedActor, SceneContext, parse_size};
use super::super::*;

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

pub(super) fn resolve_popular_actor(
    catalog: &crate::catalog::Catalog,
    raw_character: &str,
    outfit_id: Option<&str>,
    outfit_prompt: Option<&str>,
    outfit_explicit: Option<bool>,
    action: String,
    bbox: Option<[f64; 4]>,
    inherit_reference_outfit: bool,
) -> Result<ResolvedActor> {
    let resolved_id = catalog.remote_character_id(raw_character)?;
    let record = match catalog.get("character", &resolved_id) {
        Ok(record) => record,
        Err(error) if error.code == "CATALOG_NOT_FOUND"
            || (resolved_id == raw_character && error.code == "INVALID_REQUEST") => {
            let Some(id) = catalog.cast_character_alias_id(raw_character)? else {
                return Err(ApiError::new(
                    404,
                    "CAST_CHARACTER_NOT_FOUND",
                    format!("未找到角色 {raw_character}，请先用 catalog --kind character 确认角色 ID"),
                ));
            };
            catalog.get("character", &id)?
        }
        Err(error) => return Err(error),
    };
    let resolved_id = record.id.clone();
    let popular = &record.data["popular"];
    let profile = &record.data["profile"];

    let trimmed_id = outfit_id.map(str::trim).filter(|s| !s.is_empty());
    let trimmed_prompt = outfit_prompt.map(str::trim).filter(|s| !s.is_empty());
    if let (Some(id), Some(_)) = (trimmed_id, trimmed_prompt)
        && !is_clear_outfit_sentinel(id)
    {
        return Err(ApiError::invalid(
            "同一角色请只传 outfitId 或 outfitPrompt 中的一项（自定义服装时省略 outfitId 或设为 none）",
        ));
    }
    let cleared_outfit = trimmed_prompt.is_some()
        || trimmed_id.is_some_and(is_clear_outfit_sentinel);
    let explicit = cleared_outfit || outfit_explicit.unwrap_or(trimmed_id.is_some());

    let chosen_outfit_id = if cleared_outfit {
        String::new()
    } else {
        match trimmed_id {
            Some(requested) => {
                if requested.contains('/') {
                    requested.to_owned()
                } else {
                    format!("{resolved_id}/{requested}")
                }
            }
            None => catalog
                .default_outfit_id(&resolved_id)?
                .unwrap_or_default(),
        }
    };

    let outfit_record = if !chosen_outfit_id.is_empty() {
        let rec = catalog.get("outfit", &chosen_outfit_id).map_err(|_| {
            ApiError::new(
                404,
                "CAST_OUTFIT_NOT_FOUND",
                format!("未找到角色 {resolved_id} 的服装 {chosen_outfit_id}"),
            )
        })?;
        let owner = rec.data["characterId"].as_str().unwrap_or("");
        if !owner.is_empty() && owner != resolved_id {
            return Err(ApiError::new(
                422,
                "CAST_OUTFIT_MISMATCH",
                format!("服装 {chosen_outfit_id} 属于角色 {owner}，不能穿在 {resolved_id} 身上"),
            ));
        }
        Some(rec)
    } else {
        None
    };

    let outfit_data = outfit_record.as_ref().map(|rec| &rec.data["outfit"]);
    let use_identity_override = !inherit_reference_outfit || explicit;

    let raw_char_tokens = string_list(&popular["characterTokens"]);
    let exact_tokens = string_list(&popular["exactTokens"]);
    let character_tokens = if !raw_char_tokens.is_empty() {
        raw_char_tokens
    } else {
        exact_tokens.into_iter().take(1).collect()
    };
    let copyright_tokens = string_list(&popular["copyrightTokens"]);

    let override_identity = if use_identity_override {
        outfit_data
            .map(|o| string_list(&o["identityTokensOverride"]))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let base_identity_raw = string_list(&popular["identityTokens"]);
    let identity_source = if !override_identity.is_empty() {
        &override_identity
    } else {
        &base_identity_raw
    };
    let identity_tokens: Vec<String> = public_tags(identity_source)
        .into_iter()
        .filter(|token| !is_wardrobe_token(token))
        .collect();

    let raw_prose = popular["identityProse"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(identity_without_outfit)
        .unwrap_or_else(|| {
            let display = popular["displayName"]
                .as_str()
                .or_else(|| profile["name"].as_str())
                .unwrap_or(&resolved_id);
            if identity_tokens.is_empty() {
                display.to_owned()
            } else {
                format!(
                    "{display}, {}",
                    identity_tokens
                        .iter()
                        .map(|t| t.replace('_', " "))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        });

    let name = raw_prose
        .split(" from ")
        .next()
        .unwrap_or(&raw_prose)
        .split(',')
        .next()
        .unwrap_or(&raw_prose)
        .trim()
        .to_owned();
    let name = if name.is_empty() {
        popular["displayName"]
            .as_str()
            .or_else(|| profile["name"].as_str())
            .unwrap_or(&resolved_id)
            .to_owned()
    } else {
        name
    };

    let identity_prose_override = if use_identity_override {
        outfit_data
            .and_then(|o| o["identityProseOverride"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    let identity_caption = clean_cast_prose(&match identity_prose_override {
        Some(variant) => format!("{name}, {variant}"),
        None => raw_prose.clone(),
    });

    let gender = if base_identity_raw.iter().any(|token| {
        matches!(
            normalize_key(token).as_str(),
            "1boy" | "1 boy" | "male" | "man" | "male focus"
        )
    }) {
        "boy"
    } else if base_identity_raw.iter().any(|token| {
        matches!(
            normalize_key(token).as_str(),
            "1girl" | "1 girl" | "female" | "woman"
        )
    }) || !raw_prose.to_ascii_lowercase().contains("non-binary")
    {
        "girl"
    } else {
        "other"
    };

    let (outfit_tokens, outfit_caption) = if let Some(custom) = trimmed_prompt {
        let cleaned = clean_cast_prose(custom);
        (
            public_tags(&[&cleaned]),
            format_custom_outfit_caption(&cleaned),
        )
    } else if trimmed_id.is_some_and(is_clear_outfit_sentinel) {
        if trimmed_id.is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "nude" | "naked")) {
            (vec!["nude".into()], "Nude.".into())
        } else {
            (Vec::new(), String::new())
        }
    } else {
        let tokens = outfit_data
            .map(|o| public_tags(&string_list(&o["tokens"])))
            .unwrap_or_default();
        let caption = outfit_data
            .and_then(|o| o["prose"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|text| format_custom_outfit_caption(&clean_cast_prose(text)))
            .unwrap_or_else(|| {
                if tokens.is_empty() {
                    String::new()
                } else {
                    format!(
                        "Wearing {}.",
                        tokens
                            .iter()
                            .map(|t| t.replace('_', " "))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                }
            });
        (tokens, caption)
    };

    let mut aliases = Vec::new();
    for field in [
        popular["originalName"].as_str(),
        popular["displayName"].as_str(),
        profile["name"].as_str(),
    ]
    .into_iter()
    .flatten()
    {
        if !field.trim().is_empty() {
            aliases.push(field.trim().to_owned());
        }
    }
    aliases.extend(string_list(&popular["aliases"]));
    aliases.extend(character_tokens.iter().cloned());
    aliases.extend(copyright_tokens.iter().cloned());

    Ok(ResolvedActor {
        key: format!("popular:{resolved_id}"),
        name,
        character_tokens,
        copyright_tokens,
        aliases,
        identity_tokens,
        outfit_tokens,
        identity_caption,
        outfit_caption,
        outfit_explicit: explicit,
        action,
        bbox,
        gender,
    })
}

pub(super) fn resolve_scene_context(
    catalog: &crate::catalog::Catalog,
    kind: Option<&str>,
    id: &str,
) -> Result<SceneContext> {
    if id.is_empty() || id.len() > 180 {
        return Err(ApiError::invalid("目录场景或蓝图 ID 无效"));
    }
    let (resolved_kind, record) = match kind {
        Some("scene") => ("scene", catalog.get("scene", id)?),
        Some("blueprint") => ("blueprint", catalog.get("blueprint", id)?),
        Some("prompt") | None => match catalog.get("scene", id) {
            Ok(rec) => ("scene", rec),
            Err(_) => ("blueprint", catalog.get("blueprint", id).map_err(|_| {
                ApiError::new(
                    404,
                    "SCENE_RECIPE_NOT_FOUND",
                    format!("未找到目录场景或蓝图 {id}"),
                )
            })?),
        },
        Some(_) => {
            return Err(ApiError::invalid(
                "多角色同框仅支持搭配 scene 或 blueprint 目录场景，不能与 outfit/manga 混用",
            ));
        }
    };

    let data = &record.data;
    let recommended_size = data["recommendedSize"].as_str().and_then(parse_size);
    let mut prose_parts = Vec::new();
    if let Some(text) = data["animaCaption"]
        .as_str()
        .or_else(|| data["promptProse"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        prose_parts.push(text.to_owned());
    }
    if data["adult"] == true
        && let Some(nsfw) = data["nsfwProse"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        prose_parts.push(nsfw.to_owned());
    }
    let camera = data["camera"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_owned();

    let mut raw_tags = Vec::new();
    if let Some(prompt) = data["prompt"].as_str() {
        raw_tags.push(prompt.to_owned());
    }
    raw_tags.extend(string_list(&data["tags"]));
    if !camera.is_empty() && camera.is_ascii() {
        raw_tags.push(camera.clone());
    }

    let mut source_identity_terms = Vec::new();
    if resolved_kind == "blueprint"
        && let Some(owner_id) = data["characterId"].as_str().filter(|s| !s.is_empty())
        && let Ok(owner) = catalog.get("character", owner_id)
    {
        let pop = &owner.data["popular"];
        for field in [
            pop["originalName"].as_str(),
            pop["displayName"].as_str(),
            owner.data["profile"]["name"].as_str(),
        ]
        .into_iter()
        .flatten()
        {
            source_identity_terms.push(field.to_owned());
        }
        source_identity_terms.extend(string_list(&pop["aliases"]));
        source_identity_terms.extend(string_list(&pop["characterTokens"]));
        source_identity_terms.extend(string_list(&pop["copyrightTokens"]));
    } else if resolved_kind == "scene" {
        source_identity_terms.extend([
            "Ayachi Nene".into(),
            "Shiki Natsume".into(),
            "ayachi_nene".into(),
            "shiki_natsume".into(),
            "sanoba_witch".into(),
            "cafe_stella_to_shinigami_no_chou".into(),
        ]);
    }

    Ok(SceneContext {
        recommended_size,
        prose: prose_parts.join(" "),
        tags: public_tags(&raw_tags),
        camera,
        source_identity_terms,
    })
}
