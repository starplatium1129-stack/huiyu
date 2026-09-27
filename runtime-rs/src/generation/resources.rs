use super::*;
use regex::Regex;
use std::sync::LazyLock;
static SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*(?:\[[^\]]*\]|\([^)]*\))\s*$").unwrap());
static EXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(?:safetensors|ckpt|pt)$").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s-]+").unwrap());
static UNDERSCORES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_+").unwrap());
pub fn normalize_checkpoint(value: &str) -> String {
    let basename = value.trim().rsplit(['\\', '/']).next().unwrap_or("");
    let stripped = SUFFIX.replace(basename, "");
    let stripped = EXT.replace(stripped.trim(), "");
    let normalized = SPACES.replace_all(stripped.trim(), "_");
    UNDERSCORES.replace_all(&normalized, "_").to_lowercase()
}
pub fn is_wai_checkpoint(value: &str) -> bool {
    normalize_checkpoint(value) == normalize_checkpoint(constants::CHECKPOINT)
}
pub(super) async fn available(config: &Config, kind: &str, file: &str) -> bool {
    tokio::fs::metadata(
        config
            .ai_workspace_root
            .join("ComfyUI/models")
            .join(kind)
            .join(file),
    )
    .await
    .is_ok_and(|m| m.is_file())
}
pub(super) async fn super_res(config: &Config) -> Option<String> {
    for file in constants::SUPER_RES_FILES {
        if available(config, "upscale_models", file).await {
            return Some((*file).into());
        }
    }
    None
}
pub(super) async fn usable(config: &Config, input: &Input) -> bool {
    if !available(config, "checkpoints", constants::CHECKPOINT).await {
        return false;
    }
    for lora in &input.loras {
        if !available(config, "loras", &lora.file).await {
            return false;
        }
    }
    true
}
