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
