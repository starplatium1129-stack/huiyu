use super::*;
use std::sync::LazyLock;
pub(super) static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    let mut catalog: Value = serde_json::from_str(include_str!("catalog.json"))
        .expect("catalog exported from pure Node sources");
    let endfield: Value =
        serde_json::from_str(include_str!("endfield-lora.json")).expect("Endfield LoRA manifest");
    let id = endfield["id"].as_str().unwrap();
    catalog["LORAS"][id] = json!({"file":endfield["file"],"name":endfield["name"],"character":"endfield","characters":endfield["characters"].as_object().unwrap().keys().collect::<Vec<_>>(),"compatibleModels":endfield["compatibleModels"],"minStrength":0,"maxStrength":1});
    for (character, info) in endfield["characters"].as_object().unwrap() {
        catalog["CHARACTERS"][character] =
            json!({"id":character,"label":info["label"],"loraId":id});
        catalog["contract"]["CHARACTER_LORA_BINDINGS"][character] = json!(id);
    }
    catalog
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
