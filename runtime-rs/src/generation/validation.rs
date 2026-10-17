use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static STRIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<lora:[^>]+>").unwrap());
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64() != Some(0.),
        _ => true,
    }
}
pub(super) fn strip_loras(value: &str) -> String {
    STRIP.replace_all(value, "").trim().into()
}
