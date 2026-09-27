macro_rules! re {
    ($pattern:literal) => {{
        static VALUE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(&$pattern.replace(r"\s", $crate::maintenance::prompt::JS_SPACE))
                .unwrap()
        });
        &*VALUE
    }};
}
pub(super) use re;
mod normalize;
mod policy;
mod render;
pub(super) use normalize::{classify, optimize};
pub(super) use policy::{au, issues, rating, token_key, token_keys};
pub(super) use render::effective;
use serde_json::Value;
use std::sync::LazyLock;

// Literal source data only; sources.json binds every table/template to its TS
// baseline. Runtime never evaluates JavaScript or rewrites these source files.
pub(super) static CONSTANTS: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("prompt/constants.json")).unwrap());
pub(super) const JS_SPACE: &str = r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
pub(super) fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
pub(super) fn has(value: &Value, text: &str) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().any(|value| value == text))
}
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
pub(super) fn text(value: &Value) -> String {
    if !truthy(value) {
        return String::new();
    }
    match value {
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                Value::String(value) => value.clone(),
                Value::Object(_) => "[object Object]".into(),
                Value::Array(_) => text(item),
                other => crate::storage::stringify(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        value => crate::storage::stringify(value),
    }
}
pub(super) fn trim(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}
pub(super) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
pub(super) fn js_units(value: &str) -> String {
    value
        .encode_utf16()
        .map(|unit| {
            char::from_u32(if (0xd800..=0xdfff).contains(&unit) {
                0xf0000 + (unit as u32 - 0xd800)
            } else {
                unit as u32
            })
            .unwrap()
        })
        .collect()
}
