use super::*;
use std::collections::{HashMap, HashSet};

const REQUIRED: &[&str] = &[
    "id",
    "title",
    "category",
    "story",
    "storyJa",
    "char",
    "character",
    "lora",
    "emotion",
    "season",
    "time",
    "timeOfDay",
    "tags",
    "rating",
    "mature",
    "location",
    "weather",
    "camera",
    "lighting",
    "usage",
    "prompt",
    "negative",
];
fn repeat(value: &str) -> bool {
    let value = prompt::re!(r"\s+").replace_all(value, "");
    let units = value.encode_utf16().collect::<Vec<_>>();
    let mut counts = HashMap::new();
    for gram in units.windows(12) {
        let count = counts.entry(gram.to_vec()).or_insert(0);
        *count += 1;
        if *count >= 3 {
            return true;
        }
    }
    false
}
pub(super) fn validate(
    scenes: &[Value],
    pins: &Value,
    loras: &HashMap<&str, String>,
    errors: &mut Vec<String>,
) {
    let mut ids = HashSet::new();
    for (index, scene) in scenes.iter().enumerate() {
        let id = prompt::text(&scene["id"]);
        let label = if id.is_empty() {
            format!("index {index}")
        } else {
            id.clone()
        };
        if !scene.is_object() {
            errors.push(format!("{label}: scene must be an object"));
            continue;
        }
        for key in REQUIRED {
            let value = &scene[*key];
            if value.is_null() || value == "" || value.as_array().is_some_and(Vec::is_empty) {
                errors.push(format!("{label}: missing field {key}"));
            }
        }
        if state::scene_number(&id).is_none() {
            errors.push(format!(
                "{label}: id must use canonical sc001 / sc1000 format"
            ));
        }
        if !ids.insert(id.clone()) {
            errors.push(format!("{label}: duplicate id"));
        }
        if !matches!(scene["char"].as_str(), Some("nene" | "natsume" | "triad")) {
            errors.push(format!(
                "{label}: unknown char {}",
                prompt::text(&scene["char"])
            ));
        }
        if !scene["timeOfDay"].as_str().is_some_and(|time| {
            [
                "morning",
                "afternoon",
                "sunset",
                "evening",
                "night",
                "late_night",
                "dawn",
                "all_day",
            ]
            .contains(&time)
        }) {
            errors.push(format!(
                "{label}: unknown timeOfDay {}",
                prompt::text(&scene["timeOfDay"])
            ));
        }
        for key in ["character", "tags", "usage"] {
            if !scene[key].is_array() {
                errors.push(format!("{label}: {key} must be an array"));
            }
        }
        if !scene["mature"].is_boolean() {
            errors.push(format!("{label}: mature must be boolean"));
        }
        if !scene["recommendedSize"].is_null() {
            let size = prompt::text(&scene["recommendedSize"]);
            if !prompt::re!(r"^[0-9]{3,4}×[0-9]{3,4}$").is_match(&size) {
                errors.push(format!("{label}: recommendedSize must use WIDTH×HEIGHT"));
            } else if size
                .split('×')
                .any(|part| part.parse::<u32>().unwrap_or(0) < 512)
            {
                errors.push(format!("{label}: recommendedSize must be at least 512x512"));
            }
        }
        if !matches!(scene["rating"].as_str(), Some("All" | "R15" | "R18")) {
            errors.push(format!("{label}: rating must be All, R15, or R18"));
        }
        if scene["rating"].is_string() && scene["mature"] != json!(scene["rating"] == "R18") {
            errors.push(format!("{label}: mature must match R18 rating"));
        }
        let pinned = prompt::truthy(&pins[&id]);
        if !prompt::truthy(&scene["mature"])
            && !pinned
            && prompt::CONSTANTS["manual"].get(&id).is_none()
        {
            let rating = prompt::rating(scene);
            if scene["rating"] != rating {
                errors.push(format!(
                    "{label}: rating should be {rating}, found {}",
                    prompt::text(&scene["rating"])
                ));
            }
        }
        if let Some(story) = scene["story"].as_str()
            && prompt::utf16_len(story) < 80
        {
            errors.push(format!(
                "{label}: story is too short ({} < 80)",
                prompt::utf16_len(story)
            ));
        }
        if let Some(japanese) = scene["storyJa"].as_str() {
            if !prompt::re!(r"[ぁ-んァ-ヶ]").is_match(japanese) {
                errors.push(format!("{label}: storyJa must contain Japanese kana"));
            }
            if prompt::re!(r"[这们说没让还过进给为从吗边发经动觉样东门书车话气实间见听脸妈爱现开关窝败总紧头轻软应处]").is_match(japanese){errors.push(format!("{label}: storyJa contains likely untranslated Simplified Chinese"));}
            if let Some(story) = scene["story"].as_str() {
                if (story.contains('「') && story.contains('」'))
                    != (japanese.contains('「') && japanese.contains('」'))
                {
                    errors.push(format!(
                        "{label}: storyJa dialogue structure differs from story"
                    ));
                }
                if prompt::utf16_len(japanese) as f64
                    > 300.0_f64.max(prompt::utf16_len(story) as f64 * 2.4)
                {
                    errors.push(format!("{label}: storyJa is implausibly longer than story"));
                }
            }
            let header = japanese.split('】').next().unwrap_or("");
            let characters = prompt::strings(&scene["character"]);
            if characters.iter().any(|id| id == "nene") && !header.contains("寧々") {
                errors.push(format!("{label}: storyJa header is missing Nene"));
            }
            if characters.iter().any(|id| id == "natsume") && !header.contains("夏目") {
                errors.push(format!("{label}: storyJa header is missing Natsume"));
            }
            if repeat(japanese) {
                errors.push(format!(
                    "{label}: storyJa repeats the same 12-character text three times"
                ));
            }
        }
        if let Some(positive) = scene["prompt"].as_str() {
            if prompt::utf16_len(positive) < 100 {
                errors.push(format!(
                    "{label}: prompt is too short ({} < 100)",
                    prompt::utf16_len(positive)
                ));
            }
            if prompt::re!(r"(?i)_BREAK_").is_match(positive) {
                errors.push(format!("{label}: use standalone BREAK instead of _BREAK_"));
            }
            if prompt::re!(r"\{[^}]+\}").is_match(positive) {
                errors.push(format!("{label}: unresolved prompt placeholder"));
            }
        }
        let effective = prompt::effective(scene);
        if scene["negative"].is_string() {
            let negative = prompt::text(&effective["negative"])
                .split(',')
                .map(prompt::token_key)
                .filter(|token| !token.is_empty())
                .collect::<Vec<_>>();
            for token in [
                "text",
                "watermark",
                "signature",
                "bad_hands",
                "extra_fingers",
                "missing_fingers",
            ] {
                if !negative.iter().any(|value| value == token) {
                    errors.push(format!(
                        "{label}: negative prompt missing {}",
                        token.replace('_', " ")
                    ));
                }
            }
            if !pinned {
                if scene["rating"] == "All" && !negative.iter().any(|value| value == "nsfw") {
                    errors.push(format!("{label}: All scene must exclude nsfw"));
                }
                if matches!(scene["rating"].as_str(), Some("R15" | "R18")) {
                    for token in ["nsfw", "nude", "explicit"] {
                        if negative.iter().any(|value| value == token) {
                            errors.push(format!(
                                "{label}: {} negative conflicts with positive intent: {token}",
                                prompt::text(&scene["rating"])
                            ));
                        }
                    }
                    for token in ["child", "loli", "underage"] {
                        if !negative.iter().any(|value| value == token) {
                            errors.push(format!(
                                "{label}: {} negative prompt missing {token}",
                                prompt::text(&scene["rating"])
                            ));
                        }
                    }
                }
                let mut seen = HashSet::new();
                let overlap = prompt::token_keys(&prompt::text(&effective["prompt"]))
                    .into_iter()
                    .filter(|token| negative.contains(token) && seen.insert(token.clone()))
                    .collect::<Vec<_>>();
                if !overlap.is_empty() {
                    errors.push(format!(
                        "{label}: positive/negative token overlap: {}",
                        overlap.join(", ")
                    ));
                }
            }
        }
        errors.extend(
            prompt::issues(&effective, pinned)
                .into_iter()
                .map(|issue| format!("{label}: {issue}")),
        );
        errors.extend(
            prompt::au(scene)
                .into_iter()
                .map(|issue| format!("{label}: {issue}")),
        );
        if let Some(positive) = scene["prompt"].as_str() {
            for character in prompt::strings(&scene["character"]) {
                let trigger = match character.as_str() {
                    "nene" => "ayachi_nene",
                    "natsume" => "shiki_natsume",
                    _ => "",
                };
                if !trigger.is_empty() && !positive.contains(trigger) {
                    errors.push(format!("{label}: prompt missing {trigger}"));
                }
                if let Some(lora) = loras.get(character.as_str())
                    && positive.contains("<lora:")
                    && !positive.contains(&format!("<lora:{lora}:"))
                    && !prompt::text(&scene["lora"]).contains(lora)
                    && !positive.contains("anima")
                    && !positive.contains("v21")
                {
                    errors.push(format!("{label}: prompt missing LoRA {lora}"));
                }
            }
        }
        if let Some(story) = scene["story"].as_str() {
            for marker in [
                "七绪",
                "すごい",
                "魅魔",
                "猫耳",
                "Devon",
                "疏史",
                "银色发丝",
                "湿透的银色长发",
                "粉色长发",
                "粉发",
            ] {
                if story.contains(marker) {
                    errors.push(format!("{label}: stale character marker {marker}"));
                }
            }
        }
        let nene = scene["char"] == "nene"
            || prompt::strings(&scene["character"])
                .iter()
                .any(|id| id == "nene");
        let adult = scene["story"].as_str().is_some_and(|story| {
            story.contains("成年")
                || String::from_utf16_lossy(&story.encode_utf16().take(60).collect::<Vec<_>>())
                    .to_lowercase()
                    .contains("adult")
        });
        if prompt::truthy(&scene["mature"]) && nene && !adult {
            errors.push(format!(
                "{label}: mature Nene scene must be explicitly adult"
            ));
        }
    }
}
