use super::*;
use std::sync::LazyLock;
pub(super) static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("catalog.json"))
        .expect("catalog exported from pure Node sources")
});
pub fn catalog() -> Value {
    CATALOG.clone()
}
pub(super) fn model(id: &str) -> Result<&'static Value> {
    CATALOG["MODELS"]
        .get(id)
        .ok_or_else(|| error("UNKNOWN_MODEL", "未知生成模型"))
}
pub(super) fn lora(id: &str) -> Option<&'static Value> {
    CATALOG["LORAS"].get(id)
}
pub(super) fn styles() -> &'static Value {
    &CATALOG["KREA_STYLE_LORAS"]
}
pub(super) fn contract() -> &'static Value {
    &CATALOG["contract"]
}
