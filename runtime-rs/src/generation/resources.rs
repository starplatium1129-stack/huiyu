use super::*;
use regex::Regex;
use std::sync::LazyLock;
static SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s*(?:\[[^\]]*\]|\([^)]*\))\s*$").unwrap());
static EXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(?:safetensors|ckpt|pt)$").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\s-]+").unwrap());
static UNDERSCORES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_+").unwrap());
static WAI_CHECKPOINT: LazyLock<String> =
    LazyLock::new(|| normalize_checkpoint(constants::CHECKPOINT));
pub fn normalize_checkpoint(value: &str) -> String {
    let basename = value.trim().rsplit(['\\', '/']).next().unwrap_or("");
    let stripped = SUFFIX.replace(basename, "");
    let stripped = EXT.replace(stripped.trim(), "");
    let normalized = SPACES.replace_all(stripped.trim(), "_");
    UNDERSCORES.replace_all(&normalized, "_").to_lowercase()
}
pub fn is_wai_checkpoint(value: &str) -> bool {
    normalize_checkpoint(value) == WAI_CHECKPOINT.as_str()
}
async fn available(config: &Config, kind: &str, file: &str) -> bool {
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
pub(super) struct LocalStatus {
    pub comfy: bool,
    pub super_res: Option<&'static str>,
    pub upscalers: Vec<&'static str>,
    pub loras: Vec<Value>,
}
pub(super) fn local_status(root: std::path::PathBuf, comfy_online: bool) -> LocalStatus {
    let available = |kind: &str, file: &str| {
        std::fs::metadata(root.join(kind).join(file)).is_ok_and(|m| m.is_file())
    };
    let comfy = comfy_online && available("checkpoints", constants::CHECKPOINT);
    let super_res = if comfy {
        constants::SUPER_RES_FILES
            .iter()
            .copied()
            .filter(|(file, _)| available("upscale_models", file))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let upscalers = constants::SUPER_RES
        .iter()
        .copied()
        .filter(|name| super_res.iter().any(|(_, candidate)| candidate == name))
        .collect();
    let loras = constants::LORAS
        .iter()
        .map(|(id, file, character)| {
            json!({"id":id,"character":character,"available":available("loras",file)})
        })
        .collect();
    LocalStatus {
        comfy,
        super_res: super_res.first().map(|(file, _)| *file),
        upscalers,
        loras,
    }
}
pub(crate) fn super_res_name(file: &str) -> Option<&'static str> {
    constants::SUPER_RES_FILES
        .iter()
        .find_map(|(candidate, name)| (*candidate == file).then_some(*name))
}
pub(crate) async fn super_res(config: &Config, requested: Option<&str>) -> Option<String> {
    for (file, name) in constants::SUPER_RES_FILES {
        if requested.is_some_and(|requested| requested != *name) {
            continue;
        }
        if available(config, "upscale_models", file).await {
            return Some((*file).into());
        }
    }
    None
}
