//! Dynamic Krea 2 natural-language catalog recipe builder.
//! Used when `remote-scene-recipes.sqlite` does not yet contain precompiled `krea2` payloads.
use super::*;

pub(super) const KREA_TURBO: &str = "krea2-turbo";
pub(super) const KREA_RAW: &str = "krea2-raw";

fn studio_subject_prose(character: &str) -> &'static str {
    match character {
        "nene" => {
            "Ayachi Nene is the only prominent character, a woman with white hair, purple eyes, an ahoge, and pink hair ribbons."
        }
        "natsume" => {
            "Shiki Natsume is the only prominent character, a woman with black hair, golden-yellow eyes, two red hairclips, and a small mole beneath one eye."
        }
        "triad" => {
            "Ayachi Nene (white hair, purple eyes, ahoge, pink hair ribbons) and Shiki Natsume (black hair, golden-yellow eyes, two red hairclips, small mole beneath one eye) appear together."
        }
        _ => "",
    }
}

fn clean_prose(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<lora:") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start..].find('>') {
            rest = &rest[start + end + 1..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out.replace("BREAK", ", ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn identity_without_outfit(prose: &str) -> String {
    let cleaned = clean_prose(prose);
    let lower = cleaned.to_ascii_lowercase();
    for marker in [", wearing ", ", dressed in "] {
        if let Some(index) = lower.rfind(marker) {
            let prefix = cleaned[..index].trim_end_matches(|c: char| c.is_whitespace() || c == ',');
            if !prefix.is_empty() {
                return if prefix.ends_with('.') {
                    prefix.to_owned()
                } else {
                    format!("{prefix}.")
                };
            }
        }
    }
    cleaned
}

fn humanize_tokens(tokens: &Value) -> String {
    let Some(items) = tokens.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for token in items.iter().filter_map(Value::as_str) {
        let cleaned = clean_prose(token).replace('_', " ");
        let trimmed = cleaned.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("nene ")
            || trimmed.starts_with("natsume ")
            || trimmed.eq_ignore_ascii_case("1girl")
            || trimmed.eq_ignore_ascii_case("1boy")
            || trimmed.eq_ignore_ascii_case("solo")
        {
            continue;
        }
        parts.push(trimmed.to_owned());
    }
    parts.join(", ")
}

fn ensure_sentence(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with(['.', '!', '?']) {
        trimmed.to_owned()
    } else {
        format!("{trimmed}.")
    }
}

fn join_sentences(parts: Vec<String>) -> String {
    parts
        .into_iter()
        .map(|part| clean_prose(&part))
        .filter(|part| !part.is_empty())
        .map(|part| ensure_sentence(&part))
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_size(raw: &str) -> Option<(u64, u64)> {
    let normalized = raw.replace('×', "x");
    let (w, h) = normalized.split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

fn closest_size(spec: &Value, desired: Option<(u64, u64)>) -> (u64, u64) {
    let sizes: Vec<(u64, u64)> = spec["sizes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(parse_size)
        .collect();
    if sizes.is_empty() {
        return (1024, 1024);
    }
    let Some((target_w, target_h)) = desired.filter(|(w, h)| *w > 0 && *h > 0) else {
        return sizes[0];
    };
    let target_ratio = target_w as f64 / target_h as f64;
    sizes
        .into_iter()
        .min_by(|&(w1, h1), &(w2, h2)| {
            let d1 = ((w1 as f64 / h1 as f64) - target_ratio).abs();
            let d2 = ((w2 as f64 / h2 as f64) - target_ratio).abs();
            d1.total_cmp(&d2)
        })
        .unwrap_or((1024, 1024))
}

fn studio_wardrobe_outfit(db: &Connection, id: &str) -> Result<(String, String)> {
    let (character, tags): (String, String) = db
        .query_row(
            "SELECT character, tags FROM studio_wardrobe WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(recipe_missing)?;
    let parsed: Value = serde_json::from_str(&tags)?;
    Ok((character, humanize_tokens(&parsed)))
}

fn outfit_prose(catalog: &crate::catalog::Catalog, db: &Connection, id: &str) -> Result<String> {
    if id.starts_with("studio/") {
        let (_, desc) = studio_wardrobe_outfit(db, id)?;
        return Ok(if desc.is_empty() {
            String::new()
        } else {
            format!("Wearing {desc}")
        });
    }
    let record = catalog.get("outfit", id)?;
    let outfit = &record.data["outfit"];
    let prose = outfit["prose"].as_str().unwrap_or("").trim();
    if !prose.is_empty() {
        Ok(prose.to_owned())
    } else {
        let desc = humanize_tokens(&outfit["tokens"]);
        Ok(if desc.is_empty() {
            String::new()
        } else {
            format!("Wearing {desc}")
        })
    }
}

fn character_prose(catalog: &crate::catalog::Catalog, character_id: &str) -> String {
    let studio = studio_subject_prose(character_id);
    if !studio.is_empty() {
        return studio.to_owned();
    }
    let Ok(record) = catalog.get("character", character_id) else {
        return String::new();
    };
    let popular = &record.data["popular"];
    if let Some(prose) = popular["identityProse"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return identity_without_outfit(prose);
    }
    let name = popular["displayName"]
        .as_str()
        .or_else(|| record.data["profile"]["name"].as_str())
        .unwrap_or("");
    let tokens = humanize_tokens(&popular["identityTokens"]);
    match (name.is_empty(), tokens.is_empty()) {
        (false, false) => format!("{name}, {tokens}"),
        (false, true) => name.to_owned(),
        (true, false) => tokens,
        (true, true) => String::new(),
    }
}

pub(super) fn build_catalog_payload(
    library: &RecipeLibrary,
    kind: &str,
    id: &str,
    outfit: Option<&str>,
    model: &str,
    anima_fallback: &Value,
) -> Result<Value> {
    let spec = generation::native::adapters::model(model)
        .filter(|s| s["family"] == "krea2")
        .ok_or_else(|| ApiError::invalid("未知 Krea 2 原生模型"))?;

    let mut desired_size = anima_fallback["width"]
        .as_u64()
        .zip(anima_fallback["height"].as_u64());
    let prompt = match kind {
        "outfit" => {
            if id.starts_with("studio/") {
                let (character, tags_prose) = studio_wardrobe_outfit(&library.db, id)?;
                let mut parts = Vec::new();
                let subject = studio_subject_prose(&character);
                if !subject.is_empty() {
                    parts.push(subject.to_owned());
                }
                if !tags_prose.is_empty() {
                    parts.push(format!("Wearing {tags_prose}"));
                }
                parts.push("Clean anime illustration portrait, natural soft lighting".into());
                join_sentences(parts)
            } else {
                let record = library.catalog.get("outfit", id)?;
                let character_id = record.data["characterId"].as_str().unwrap_or("");
                let mut parts = Vec::new();
                let identity = character_prose(&library.catalog, character_id);
                if !identity.is_empty() {
                    parts.push(identity);
                }
                let outfit_text = outfit_prose(&library.catalog, &library.db, id)?;
                if !outfit_text.is_empty() {
                    parts.push(outfit_text);
                }
                parts.push("Clean anime illustration portrait, natural soft lighting".into());
                join_sentences(parts)
            }
        }
        "scene" => {
            let record = library.catalog.get("scene", id)?;
            let data = &record.data;
            if let Some(raw) = data["recommendedSize"].as_str().and_then(parse_size) {
                desired_size = Some(raw);
            }
            let character = data["char"].as_str().unwrap_or("none");
            let mut parts = Vec::new();
            let subject = studio_subject_prose(character);
            if !subject.is_empty() {
                parts.push(subject.to_owned());
            }
            if let Some(outfit_id) = outfit {
                let outfit_text = outfit_prose(&library.catalog, &library.db, outfit_id)?;
                if !outfit_text.is_empty() {
                    parts.push(outfit_text);
                }
            }
            let caption = data["animaCaption"]
                .as_str()
                .or_else(|| data["promptProse"].as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(caption) = caption {
                parts.push(caption.to_owned());
            } else if let Some(raw) = data["prompt"].as_str() {
                let cleaned = clean_prose(raw).replace('_', " ");
                if !cleaned.is_empty() {
                    parts.push(cleaned);
                }
            }
            join_sentences(parts)
        }
        "blueprint" => {
            let record = library.catalog.get("blueprint", id)?;
            let data = &record.data;
            if let Some(raw) = data["recommendedSize"].as_str().and_then(parse_size) {
                desired_size = Some(raw);
            }
            let character_id = data["characterId"].as_str().unwrap_or("");
            let adult = data["adult"] == true;
            let mut parts = Vec::new();
            let identity = character_prose(&library.catalog, character_id);
            if !identity.is_empty() {
                parts.push(identity);
            }
            if let Some(outfit_id) = outfit {
                let outfit_text = outfit_prose(&library.catalog, &library.db, outfit_id)?;
                if !outfit_text.is_empty() {
                    parts.push(outfit_text);
                }
            } else if !adult
                && let Some(default_outfit_id) = data["outfitId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
            {
                let full_id = if default_outfit_id.contains('/') {
                    default_outfit_id.to_owned()
                } else {
                    format!("{character_id}/{default_outfit_id}")
                };
                if let Ok(outfit_text) = outfit_prose(&library.catalog, &library.db, &full_id)
                    && !outfit_text.is_empty()
                {
                    parts.push(outfit_text);
                }
            }
            if let Some(prose) = data["promptProse"]
                .as_str()
                .or_else(|| data["animaCaption"].as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                parts.push(prose.to_owned());
            }
            if adult
                && let Some(nsfw) = data["nsfwProse"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            {
                parts.push(nsfw.to_owned());
            }
            if let Some(camera) = data["camera"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.is_ascii())
            {
                parts.push(format!("Camera framing: {camera}"));
            }
            join_sentences(parts)
        }
        _ => return Err(recipe_missing()),
    };

    if prompt.trim().is_empty() {
        return Err(ApiError::new(
            422,
            "KREA_RECIPE_EMPTY",
            "该目录记录缺少可用于 Krea 2 的自然语言描述",
        ));
    }
    let prompt = if prompt.encode_utf16().count() > 11_500 {
        prompt.chars().take(11_000).collect()
    } else {
        prompt
    };
    let (width, height) = closest_size(spec, desired_size);
    Ok(json!({
        "modelId": model,
        "prompt": prompt,
        "width": width,
        "height": height,
        "steps": spec["steps"],
        "cfg": spec["cfg"],
    }))
}
