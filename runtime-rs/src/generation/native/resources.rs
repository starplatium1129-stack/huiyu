//! Local file identity shared by discovery, status and task admission.
//! Call from a blocking filesystem job; readiness does not prove GPU compatibility.
use std::path::{Path, PathBuf};

pub(crate) const REMACRI_FILE: &str = "4x_foolhardy_Remacri.safetensors";
const CLIPSEG_FILES: [&str; 7] = [
    "config.json", "preprocessor_config.json", "tokenizer_config.json",
    "special_tokens_map.json", "vocab.json", "merges.txt", "model.safetensors",
];

pub(crate) fn within(root: &Path, path: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    (path.starts_with(&root) && path != root).then_some(path)
}

pub(crate) fn file(root: &Path, name: &str, nonempty: bool) -> Option<PathBuf> {
    let path = within(root, &root.join(name))?;
    std::fs::metadata(&path).ok()
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
