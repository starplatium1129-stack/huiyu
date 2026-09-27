use super::*;
use regex::Regex;
use std::{collections::HashMap, sync::LazyLock};
pub(super) fn table() -> &'static Value {
    &catalog::CATALOG["prose"]
}
static PATTERNS: LazyLock<HashMap<String, Regex>> = LazyLock::new(|| {
    let mut patterns = HashMap::new();
    let source = table();
    for key in [
        "CAMERA_MENTION_RE",
        "MOTION_MENTION_RE",
        "CJK_DIALOGUE_RE",
        "JAPANESE_DIALOGUE_RE",
    ] {
        patterns.insert(key.into(), compile(&source[key]));
    }
    for group in ["H3_SCENE_SOUND", "H3_SCENE_MUSIC"] {
        for (index, item) in source[group].as_array().unwrap().iter().enumerate() {
            patterns.insert(format!("{group}:{index}"), compile(&item["re"]));
        }
    }
    patterns
});
fn compile(value: &Value) -> Regex {
    let source = value["source"]
        .as_str()
        .unwrap()
        .replace(r"\b", r"(?-u:\b)");
    Regex::new(&format!(
        "{}{}",
        if value["flags"].as_str().unwrap_or("").contains('i') {
            "(?i)"
        } else {
            ""
        },
        source
    ))
    .expect("legacy video regexp is supported")
}
fn matched(name: &str, text: &str) -> bool {
    PATTERNS[name].is_match(text)
}
fn derived(prompt: &str, group: &str, field: &str, fallback: &str) -> String {
    for (index, item) in table()[group].as_array().unwrap().iter().enumerate() {
        if matched(&format!("{group}:{index}"), prompt) {
            return item[field].as_str().unwrap().into();
        }
    }
    table()[fallback].as_str().unwrap().into()
}
pub(super) fn language(dialogue: &str, selected: &str) -> &'static str {
    match selected {
        "zh" => "Chinese",
        "ja" => "Japanese",
        "en" => "English",
        _ if matched("JAPANESE_DIALOGUE_RE", dialogue) => "Japanese",
        _ if matched("CJK_DIALOGUE_RE", dialogue) => "Chinese",
        _ => "English",
    }
}
pub(super) fn frame_count(seconds: u64) -> u64 {
    let count = (seconds * 24).max(5) as i64;
    (count + (5 - count % 17) % 17) as u64
}
pub(super) fn prompt(body: &Value, h3: bool, seconds: u64, references: &[Value]) -> String {
    let user = body["prompt"].as_str().unwrap().trim();
    let camera = body["camera"].as_str().unwrap();
    let motion = body["motion"].as_str().unwrap();
    let mut lines = Vec::new();
    if !h3 {
        lines.push(user.to_string());
        if !matched("CAMERA_MENTION_RE", user) {
            lines.push(table()["CAMERA"][camera].as_str().unwrap().into());
        }
        if !matched("MOTION_MENTION_RE", user) {
            lines.push(table()["MOTION"][motion].as_str().unwrap().into());
        }
        lines.push("动作从开始到结束保持连续，角色身份、服装、光照和场景结构一致。".into());
        return lines.join("\n");
    }
    let image = generation::truthy(&body["image"]);
    let last = generation::truthy(&body["lastFrame"]);
    let style = table()["H3_STYLE"].as_str().unwrap();
    let seconds_fixed = format!("{:.2}", seconds as f64);
    let description = if image && last {
        lines.push(format!("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the {seconds_fixed}-second mark of the target video."));
        lines.push(String::new());
        format!(
            "integrated_multimodal_description: [Shot 1] {style} — {user} The shot begins in the position, framing, and scene established by Picture 1 and settles into the final pose, spacing, and composition established by Picture 2 at the end of the shot."
        )
    } else if last {
        lines.push(format!("How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the {seconds_fixed}-second mark of the target video."));
        lines.push(String::new());
        format!(
            "integrated_multimodal_description: [Shot 1] {style} — {user} The scene begins in a plausible earlier state and gradually converges to the pose, composition, lighting, and scene structure established by <Picture 1> by the end of the shot."
        )
    } else if image {
        lines.push("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.".into());
        lines.push(String::new());
        format!(
            "integrated_multimodal_description: [Shot 1] {style} — preserve the subject, clothing, hairstyle, and scene from <Picture 1>, then {user}"
        )
    } else {
        format!("integrated_multimodal_description: [Shot 1] {style}, {user}")
    };
    lines.push(description);
    if let Some(size) = body["shotSize"].as_str().filter(|s| !s.is_empty()) {
        lines.push(
            table()["H3_SHOT_SIZE"][size]["line"]
                .as_str()
                .unwrap()
                .into(),
        );
    }
    if !matched("CAMERA_MENTION_RE", user) {
        lines.push(table()["H3_CAMERA"][camera].as_str().unwrap().into());
    }
    if !matched("MOTION_MENTION_RE", user) {
        lines.push(table()["H3_MOTION"][motion].as_str().unwrap().into());
    }
    if let Some(dialogue) = body["dialogue"].as_str().filter(|s| !s.is_empty()) {
        lines.push(format!(
            " The subject in the frame (S1) says: <d>[{}] {dialogue}</d>",
            language(dialogue, body["dialogueLang"].as_str().unwrap_or("auto"))
        ));
    }
    if !references.is_empty() {
        let pictures = (1..=references.len())
            .map(|n| format!("<Picture {n}>"))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Character identity anchors: {pictures}{}",if references.len()==1{" - the shot contains exactly one character: <Picture 1>. No other people, no reflections, no duplicate or mirrored copies."}else{" - each <Picture N> is a distinct character: keep every character's face, hairstyle, outfit and identity consistent with their own picture, and never swap or merge characters."}));
    }
    lines.push("Character identity, clothing, lighting, and scene structure remain consistent from start to finish.".into());
    lines.push(String::new());
    lines.push(format!(
        "overall_soundscape: {}",
        derived(user, "H3_SCENE_SOUND", "sound", "H3_SOUNDSCAPE")
    ));
    lines.push(String::new());
    lines.push(format!(
        "non_diegetic_music: {}",
        derived(user, "H3_SCENE_MUSIC", "music", "H3_MUSIC")
    ));
    lines.join("\n")
}
