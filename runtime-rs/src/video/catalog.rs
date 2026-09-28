use super::*;
use std::sync::LazyLock;
pub(super) static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("catalog.json"))
        .expect("video catalog exported from legacy pure modules")
});
pub fn catalog() -> Value {
    CATALOG.clone()
}
pub(super) fn constants() -> &'static Value {
    &CATALOG["constants"]
}
pub(super) fn model(id: &str) -> Option<&'static Value> {
    constants()["MODEL_BY_ID"].get(id)
}
