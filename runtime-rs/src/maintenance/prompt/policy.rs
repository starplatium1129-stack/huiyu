use super::{CONSTANTS, js_units, trim};
use serde_json::Value;
use std::{collections::HashSet, sync::LazyLock};

fn token_key(value: &str) -> String {
    let value = trim(value);
    if value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return value.to_owned();
    }
    let token = value.to_lowercase();
    if token.is_empty() || token.starts_with("<lora:") || token == "break" {
        return token;
    }
    let token = re!(r"^[\s(\[{]+").replace_all(&token, "");
    let token = re!(r"[\s)\]}]+$").replace_all(&token, "");
    let token = re!(r":([0-9]*\.)?[0-9]+$").replace_all(&token, "");
    re!(r"[\s-]+").replace_all(trim(&token), "_").into_owned()
}
fn token_keys(value: &str) -> impl Iterator<Item = String> + '_ {
    re!(r"(?i)\s*,?\s*(?-u:\b)BREAK(?-u:\b)\s*,?\s*")
        .split(value)
        .flat_map(|section| section.split(','))
        .map(trim)
        .filter(|s| !s.is_empty())
        .map(token_key)
        .filter(|key| !key.is_empty())
}
fn positive_keys(prompt: &str, tags: &[Value]) -> HashSet<String> {
    tags.iter()
        .filter_map(Value::as_str)
        .map(token_key)
        .chain(token_keys(prompt))
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
pub(in crate::maintenance) fn rating(
    title: &str,
    description: &str,
    prompt: &str,
    tags: &[Value],
) -> &'static str {
    static R18: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| stories("R18_STORY"));
    static R15: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| stories("R15_STORY"));
    let keys = positive_keys(prompt, tags);
    let matches = |name: &str| {
        CONSTANTS["policy"][name].as_array().is_some_and(|tags| {
            tags.iter()
                .filter_map(Value::as_str)
                .any(|tag| keys.contains(tag))
        })
    };
    if matches("R18_TAGS") {
        return "R18";
    }
    let story = js_units(&format!("{title} {description} {prompt}").to_lowercase());
    if R18.iter().any(|pattern| pattern.is_match(&story)) {
        "R18"
    } else if matches("R15_TAGS") || R15.iter().any(|pattern| pattern.is_match(&story)) {
        "R15"
    } else {
        "All"
    }
}
