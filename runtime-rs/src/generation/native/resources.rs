//! Local file identity shared by discovery, status and task admission.
//! Call from a blocking filesystem job; readiness does not prove GPU compatibility.
use std::path::{Path, PathBuf};

pub(crate) const REMACRI_FILE: &str = "4x_foolhardy_Remacri.safetensors";
// worker.py dependencies()/--serve, plus the supported RES sampler's sibling.
// Conversion, calibration and benchmark tools are separate maintenance entries.
pub(super) const ANIMA_WORKER_FILES: &[&str] = &[
    "masked_anima.py",
    "clipseg_mask.py",
    "teacache_anima.py",
    "anima_cache.py",
    "worker_lifecycle.py",
    "anima_local_cache.py",
    "teacache_profile.py",
    "resident_anima.py",
    "anima_text_cache.py",
    "inference_metrics.py",
    "anima_lora.py",
    "anima_lora_fusion.py",
    "anima_sampling.py",
    "anima_res_scheduler.py",
    "anima_refinement.py",
    "anima_vae.py",
    "anima_tiling.py",
    "anima_postprocess.py",
    "anima_prompt_weights.py",
    "anima_upscale.py",
    "native_hash.py",
    "native_upload.py",
    "anima_loader.py",
    "anima_memory.py",
    "locked_identity.py",
    "anima_acceleration.py",
    "native_memory.py",
    "anima_composition.py",
    "anima_lllite.py",
    "anima_regions.py",
];
const CLIPSEG_FILES: [&str; 7] = [
    "config.json",
    "preprocessor_config.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
    "model.safetensors",
];

pub(crate) fn within(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    (path.starts_with(&root) && path != root).then_some(path)
}

pub(crate) fn file(root: &Path, name: &str, nonempty: bool) -> Option<PathBuf> {
    let path = within(root, &root.join(name))?;
    std::fs::metadata(&path)
        .ok()
        .filter(|meta| meta.is_file() && (!nonempty || meta.len() > 0))
        .map(|_| path)
}

pub(crate) fn remacri(root: &Path) -> Option<PathBuf> {
    file(root, &format!("upscale_models/{REMACRI_FILE}"), true)
}

pub(crate) fn clipseg(root: &Path) -> Option<PathBuf> {
    let path = within(root, &root.join("clipseg-rd64-refined"))?;
    for name in CLIPSEG_FILES {
        file(&path, name, true)?;
    }
    Some(path)
}

/// The configured entry and its required siblings, never weights or Python dependencies.
pub(crate) fn worker_bundle_issue(worker: &Path, files: &[&str]) -> Option<String> {
    std::iter::once(worker.to_path_buf())
        .chain(files.iter().map(|name| worker.with_file_name(name)))
        .find(|path| !std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0))
        .map(|path| {
            format!(
                "缺少或为空的随包推理文件：{}",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })
}
