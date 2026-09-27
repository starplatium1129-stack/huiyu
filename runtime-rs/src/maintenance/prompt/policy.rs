use super::{CONSTANTS, has, js_units, strings, text, trim};
use serde_json::Value;
use std::{collections::HashSet, sync::LazyLock};

pub(in crate::maintenance) fn token_key(value: &str) -> String {
    let token = trim(value).to_lowercase();
    if token.is_empty() || token.starts_with("<lora:") || token == "break" {
        return token;
    }
    let token = re!(r"^[\s(\[{]+").replace_all(&token, "");
    let token = re!(r"[\s)\]}]+$").replace_all(&token, "");
    let token = re!(r":([0-9]*\.)?[0-9]+$").replace_all(&token, "");
    re!(r"[\s-]+").replace_all(trim(&token), "_").into_owned()
}
pub(in crate::maintenance) fn segments(value: &str) -> Vec<Vec<String>> {
    re!(r"(?i)\s*,?\s*(?-u:\b)BREAK(?-u:\b)\s*,?\s*")
        .split(value)
        .map(|section| {
            section
                .split(',')
                .map(trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .collect()
}
pub(in crate::maintenance) fn token_keys(value: &str) -> Vec<String> {
    segments(value)
        .into_iter()
        .flatten()
        .map(|token| token_key(&token))
        .filter(|key| !key.is_empty())
        .collect()
}
pub(in crate::maintenance) fn positive_keys(scene: &Value) -> HashSet<String> {
    strings(&scene["tags"])
        .into_iter()
        .map(|token| token_key(&token))
        .chain(token_keys(&text(&scene["prompt"])))
        .filter(|key| !key.is_empty())
        .collect()
}
fn stories(name: &str) -> Vec<regex::Regex> {
    CONSTANTS["policy"][name]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            regex::Regex::new(
                &item["pattern"]
                    .as_str()
                    .unwrap()
                    .replace('.', r"[^\r\n\u{2028}\u{2029}]"),
            )
            .unwrap()
        })
        .collect()
}
pub(in crate::maintenance) fn rating(scene: &Value) -> &'static str {
    static R18: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| stories("R18_STORY"));
    static R15: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| stories("R15_STORY"));
    let keys = positive_keys(scene);
    let story =
        js_units(&format!("{} {}", text(&scene["title"]), text(&scene["story"])).to_lowercase());
    if keys
        .iter()
        .any(|key| has(&CONSTANTS["policy"]["R18_TAGS"], key))
        || R18.iter().any(|pattern| pattern.is_match(&story))
    {
        "R18"
    } else if keys
        .iter()
        .any(|key| has(&CONSTANTS["policy"]["R15_TAGS"], key))
        || R15.iter().any(|pattern| pattern.is_match(&story))
    {
        "R15"
    } else {
        "All"
    }
}
pub(in crate::maintenance) fn framing(scene: &Value) -> Vec<String> {
    let keys = positive_keys(scene);
    let close = keys.contains("close_up") || keys.contains("face_focus");
    let medium = keys.contains("medium_shot");
    let wide = ["wide_shot", "full_body", "long_shot"]
        .iter()
        .any(|key| keys.contains(*key));
    let mut errors = Vec::new();
    if close && medium {
        errors.push("close_up + medium_shot".into());
    }
    if close && wide {
        errors.push("close_up + wide/full_body".into());
    }
    if medium && keys.contains("wide_shot") {
        errors.push("medium_shot + wide_shot".into());
    }
    errors
}
fn poses(keys: &HashSet<String>) -> Vec<&'static str> {
    [
        ("standing", vec!["standing"]),
        (
            "sitting",
            vec![
                "sitting",
                "sitting_on_bed",
                "sitting_on_chair",
                "sitting_on_sofa",
                "sitting_on_floor",
                "sitting_on_counter",
                "sitting_on_desk",
                "sitting_on_bench",
                "sitting_on_lap",
            ],
        ),
        (
            "lying",
            vec![
                "lying",
                "lying_on_bed",
                "lying_on_couch",
                "lying_on_floor",
                "lying_on_bench",
                "lying_on_table",
                "lying_on_lap",
                "lying_on_stomach",
            ],
        ),
        ("kneeling", vec!["kneeling", "all_fours"]),
    ]
    .into_iter()
    .filter(|(_, tags)| tags.iter().any(|tag| keys.contains(*tag)))
    .map(|(name, _)| name)
    .collect()
}
pub(in crate::maintenance) fn pose(scene: &Value) -> Vec<String> {
    let prompt = text(&scene["prompt"]);
    if scene["char"] == "triad" || re!(r"(?i)(?-u:\b)BREAK(?-u:\b)").is_match(&prompt) {
        return segments(&prompt)
            .iter()
            .enumerate()
            .filter_map(|(index, segment)| {
                let active = poses(&segment.iter().map(|token| token_key(token)).collect());
                (active.len() > 1).then(|| format!("segment {}: {}", index + 1, active.join(" + ")))
            })
            .collect();
    }
    let active = poses(&positive_keys(scene));
    if active.len() > 1 {
        vec![active.join(" + ")]
    } else {
        Vec::new()
    }
}
pub(in crate::maintenance) fn gaze(scene: &Value) -> Vec<String> {
    segments(&text(&scene["prompt"]))
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let keys = segment
                .iter()
                .map(|token| token_key(token))
                .collect::<HashSet<_>>();
            (keys.contains("closed_eyes") && keys.contains("looking_at_viewer"))
                .then(|| format!("segment {}: closed_eyes + looking_at_viewer", index + 1))
        })
        .collect()
}
pub(in crate::maintenance) fn adult(scene: &Value) -> Vec<String> {
    if scene["rating"] != "R18" {
        return Vec::new();
    }
    let positive = positive_keys(scene);
    let prompt = token_keys(&text(&scene["prompt"]));
    let negative = text(&scene["negative"])
        .split(',')
        .map(token_key)
        .collect::<HashSet<_>>();
    let mut errors = Vec::new();
    if !prompt
        .iter()
        .any(|key| key == "adult" || key.starts_with("adult_") || key.starts_with("adult-"))
    {
        errors.push("R18 positive prompt must include adult".into());
    }
    for key in strings(&CONSTANTS["policy"]["ADULT_SAFETY_NEGATIVE"]) {
        if !negative.contains(&key) {
            errors.push(format!("R18 negative prompt missing {key}"));
        }
    }
    for key in strings(&CONSTANTS["policy"]["YOUTH_UNIFORM_TAGS"]) {
        if positive.contains(&key) {
            errors.push(format!("R18 positive prompt cannot include {key}"));
        }
    }
    errors
}
pub(in crate::maintenance) fn au(scene: &Value) -> Vec<String> {
    let story = re!(r"(?i)(?-u:\b)AU(?-u:\b)").is_match(&text(&scene["story"]));
    let category = re!(r"(?i)AU|Active_Sync|同人").is_match(&text(&scene["category"]));
    let tag = strings(&scene["tags"])
        .iter()
        .any(|tag| token_key(tag).ends_with("_au"));
    if story && !category && !tag {
        vec!["AU story needs AU category or *_au metadata tag".into()]
    } else if tag && !story && !category {
        vec!["AU metadata tag needs an AU story/category marker".into()]
    } else {
        Vec::new()
    }
}
pub(in crate::maintenance) fn issues(scene: &Value, pinned: bool) -> Vec<String> {
    let mut errors = Vec::new();
    if !pinned {
        errors.extend(adult(scene));
    }
    errors.extend(
        framing(scene)
            .into_iter()
            .map(|error| format!("conflicting framing {error}")),
    );
    errors.extend(
        pose(scene)
            .into_iter()
            .map(|error| format!("conflicting pose {error}")),
    );
    errors.extend(
        gaze(scene)
            .into_iter()
            .map(|error| format!("conflicting gaze {error}")),
    );
    errors
}
