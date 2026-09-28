use super::{CONSTANTS, has, strings, text, trim};
use serde_json::{Value, json};
use std::collections::HashSet;

fn normalize(value: &str) -> String {
    let value = re!(r"(?i)^\s*\[NEG\]\s*").replace_all(value, "");
    let value = re!(r"(?i)^\s*<lora:|>\s*$").replace_all(&value, "");
    let value = re!(r"^\s*\(+|\)+\s*$").replace_all(&value, "");
    let value = re!(r":\s*-?[0-9]+(?:\.[0-9]+)?\s*$").replace_all(&value, "");
    re!(r"[\s\-/]+")
        .replace_all(&trim(&value).to_lowercase(), "_")
        .into_owned()
}
fn tokens(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn sections(value: &str) -> Vec<String> {
    re!(r"(?i)\s*,?\s*(?-u:\b)BREAK(?-u:\b)\s*,?\s*")
        .split(value)
        .map(trim)
        .map(str::to_owned)
        .collect()
}
fn dedupe_segment(value: &str) -> String {
    let mut seen = HashSet::new();
    tokens(value)
        .into_iter()
        .filter(|token| {
            let key = normalize(token);
            !key.is_empty() && key != "break" && seen.insert(key)
        })
        .collect::<Vec<_>>()
        .join(", ")
}
fn dedupe(value: &str) -> String {
    sections(value)
        .into_iter()
        .map(|section| dedupe_segment(&section))
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join(" BREAK ")
}
fn anima_token(value: &str) -> String {
    if re!(r"(?i)^(?:nene_|natsume_)[a-z0-9_]+$").is_match(value) {
        return value.to_owned();
    }
    let mut scores = Vec::new();
    let protected = re!(r"(?i)(?-u:\b)score_([0-9]+)(?-u:\b)").replace_all(
        value,
        |captures: &regex::Captures<'_>| {
            let marker = format!("ZZAICSSCORE{}ZZ", scores.len());
            scores.push(format!("score_{}", &captures[1]));
            marker
        },
    );
    let mut formatted = re!(r"\s+")
        .replace_all(&protected.replace('_', " "), " ")
        .trim()
        .to_owned();
    for (index, score) in scores.into_iter().enumerate().rev() {
        formatted = formatted.replacen(&format!("ZZAICSSCORE{index}ZZ"), &score, 1);
    }
    formatted
}
fn format_anima(value: &str) -> String {
    let clean = re!(r"(?i)<lora:[^>]+>").replace_all(value, "");
    sections(&dedupe(&clean))
        .into_iter()
        .map(|section| {
            tokens(&section)
                .iter()
                .map(|token| anima_token(token))
                .filter(|token| !token.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join(" BREAK ")
}
fn sanitize(value: &str, identity: Option<&str>) -> String {
    sections(value)
        .iter()
        .map(|section| {
            tokens(section)
                .into_iter()
                .filter(|token| {
                    let key = normalize(token);
                    !(identity.is_some_and(|name| has(&CONSTANTS["identity"][name], &key))
                        || has(&CONSTANTS["identity"]["SOLO_EXTRA_SUBJECT_TOKENS"], &key)
                        || re!(r"(?i)(?:^|_)(?:male|man|men|boy|boys|guy|guys)(?:_|$)")
                            .is_match(&key))
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join(" BREAK ")
}
fn dual(value: &str) -> String {
    let parts = sections(value);
    let left = parts.first().map(String::as_str).unwrap_or("");
    let right = parts.get(1).map(String::as_str).unwrap_or("");
    let (global, left) = match left.rfind('(') {
        Some(at) => (&left[..at], &left[at..]),
        None => (left, ""),
    };
    let global = re!(r",\s*$").replace_all(global, "");
    let nene = [
        "ayachi_nene",
        "white_hair",
        "very_long_hair",
        "low_twintails",
        "purple_eyes",
        "ahoge",
        "hair_ribbon",
    ];
    let natsume = [
        "shiki_natsume",
        "black_hair",
        "long_hair",
        "yellow_eyes",
        "mole_under_eye",
        "hairclip",
    ];
    let merge = |block: &str, identity: &[&str]| {
        let raw = trim(block);
        let raw = raw.strip_prefix('(').unwrap_or(raw);
        let raw = raw.strip_suffix(')').unwrap_or(raw);
        format!(
            "({})",
            dedupe(
                &identity
                    .iter()
                    .map(|value| (*value).to_owned())
                    .chain(tokens(raw))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        )
    };
    let left = merge(
        left,
        if left.to_lowercase().contains("shiki_natsume") {
            &natsume[..]
        } else {
            &nene[..]
        },
    );
    let right = merge(
        right,
        if right.to_lowercase().contains("ayachi_nene") {
            &nene[..]
        } else {
            &natsume[..]
        },
    );
    format!(
        "{} BREAK {right}",
        if global.is_empty() {
            left
        } else {
            format!("{global}, {left}")
        }
    )
}
fn tag(value: &str) -> String {
    let value = trim(value).to_lowercase();
    let value = re!(r"^\(+").replace_all(&value, "");
    let value = re!(r"\)+$").replace_all(&value, "");
    let value = re!(r":\s*-?[0-9]+(?:\.[0-9]+)?\s*$").replace_all(&value, "");
    let value = re!(r"[\s-]+").replace_all(&value, "_");
    re!(r"_+").replace_all(&value, "_").into_owned()
}
fn shot(scene: &Value) -> Option<String> {
    let camera = text(&scene["camera"]);
    let camera = trim(&camera).to_lowercase();
    let normalized = tag(&camera);
    if has(&CONSTANTS["shot"]["SHOT_IDS"], &normalized) {
        return Some(normalized);
    }
    for (pattern, shot) in [
        (re!(r"主观|第一人称|男友视角|(?-u:\b)pov(?-u:\b)"), "pov"),
        (re!(r"手部|局部|细节"), "detail"),
        (re!(r"近景|特写|面部"), "close"),
        (re!(r"半身|中景|上半身"), "medium"),
        (re!(r"全身|远景|全景"), "wide"),
        (re!(r"俯视|俯瞰"), "high"),
        (re!(r"仰视|微仰"), "low"),
        (re!(r"侧面|侧方|侧身|侧脸"), "side"),
        (re!(r"回眸|回头"), "turn"),
    ] {
        if pattern.is_match(&camera) {
            return Some(shot.into());
        }
    }
    let tags = strings(&scene["tags"])
        .iter()
        .map(|value| tag(value))
        .collect::<Vec<_>>();
    strings(&CONSTANTS["shot"]["SHOT_PRIORITY"])
        .into_iter()
        .find(|shot| {
            tags.iter()
                .any(|key| CONSTANTS["shot"]["TAG_TO_SHOT"][key] == *shot)
        })
}
fn framing_shot(shot: Option<&str>, scene: &Value) -> Option<String> {
    let shot = shot?;
    if ["close", "detail", "medium", "wide"].contains(&shot) {
        return Some(shot.into());
    }
    let camera = text(&scene["camera"]).to_lowercase();
    for (pattern, framing) in [
        (re!(r"特写|近景|close[-_ ]?up|portrait"), "close"),
        (re!(r"全身|远景|wide[-_ ]?shot|full[-_ ]?body"), "wide"),
        (re!(r"半身|中景|medium[-_ ]?shot"), "medium"),
    ] {
        if pattern.is_match(&camera) {
            return Some(framing.into());
        }
    }
    Some(shot.into())
}
fn filter_framing(value: &str, shot: Option<&str>) -> String {
    let drop = match shot {
        Some("wide") => ["CLOSE_TOKENS", "MID_TOKENS"],
        Some("close" | "detail") => ["WIDE_TOKENS", "MID_TOKENS"],
        Some("medium") => ["WIDE_TOKENS", "CLOSE_TOKENS"],
        _ => return value.into(),
    };
    sections(value)
        .iter()
        .map(|section| {
            tokens(section)
                .into_iter()
                .filter(|token| {
                    !drop
                        .iter()
                        .any(|group| has(&CONSTANTS["framing"][*group], &normalize(token)))
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join(" BREAK ")
}
fn template(scene: &Value, shot: Option<&str>) -> String {
    let prompt = text(&scene["prompt"]);
    if prompt.is_empty() {
        return prompt;
    }
    let prompt = re!(r"(?i)<lora:[^>]+>").replace_all(&prompt, "");
    let prompt = re!(r"(?i)_BREAK_").replace_all(&prompt, " BREAK ");
    let mut prompt = tokens(&prompt).join(", ");
    match scene["char"].as_str() {
        Some("triad") => prompt = dual(&prompt),
        Some("nene") => prompt = sanitize(&prompt, Some("NENE_IDENTITY_TOKENS")),
        Some("natsume") => prompt = sanitize(&prompt, Some("NATSUME_IDENTITY_TOKENS")),
        _ => {}
    }
    // renderedScene fixes engine=Anima with no profile; its capability is solo.
    prompt = sanitize(&prompt, None);
    filter_framing(&format_anima(&prompt), framing_shot(shot, scene).as_deref())
}
fn negative(scene: &Value, shot: Option<&str>) -> String {
    let base = format_anima(&text(&scene["negative"]));
    let protection = CONSTANTS["negative"].as_str().unwrap();
    let mut seen = HashSet::new();
    let merged = tokens(&format!("{protection}, {base}"))
        .into_iter()
        .filter(|token| seen.insert(normalize(token)))
        .collect::<Vec<_>>();
    let rating = text(&scene["rating"]).to_uppercase();
    let rating = if rating == "R18" || super::truthy(&scene["mature"]) {
        "R18"
    } else if rating == "R15" {
        "R15"
    } else {
        "ALL"
    };
    let mut filtered = merged
        .into_iter()
        .filter(|token| {
            let key = normalize(token);
            !((rating != "ALL" && ["nsfw", "nude", "naked", "explicit"].contains(&key.as_str()))
                || (matches!(shot, Some("close" | "detail")) && key == "cropped")
                || (scene["char"] == "triad" && key == "duplicate"))
        })
        .collect::<Vec<_>>();
    filtered.extend(
        if rating == "ALL" {
            ["nsfw", "nude", "explicit"]
        } else {
            ["child", "loli", "underage"]
        }
        .into_iter()
        .map(str::to_owned),
    );
    format_anima(&dedupe_segment(&filtered.join(", ")))
}
pub(in crate::maintenance) fn effective(scene: &Value) -> Value {
    let shot = shot(scene);
    let mut value = scene.clone();
    value["tags"] = json!([]);
    value["prompt"] = template(scene, shot.as_deref()).into();
    value["negative"] = negative(scene, shot.as_deref()).into();
    value
}
