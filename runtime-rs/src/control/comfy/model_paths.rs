use crate::error::{ApiError, Result};
use serde_json::json;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

// ComfyUI loads its own extra_model_paths.yaml before the CLI configs. The
// latter's is_default=true moves these directories ahead of stale/other roots.
// Persist our own CLI config so Comfy restarts can reuse argv. Never rewrite the
// user's extra_model_paths.yaml or infer a workspace from its possibly old path.
pub(super) fn create(workspace: &Path, runtime: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(runtime)?;
    let path = runtime.join("huiyu-comfy-model-paths.yaml");
    let mut file = tempfile::Builder::new()
        .prefix("comfy-model-paths-")
        .suffix(".yaml")
        .tempfile_in(runtime)?;
    // JSON is valid YAML and safely quotes Windows paths and non-ASCII names.
    serde_json::to_writer(
        &mut file,
        &json!({"huiyu_models":{
            "base_path":workspace.join("ComfyUI/models"),
            "is_default":true,
            "diffusion_models":"diffusion_models",
            "text_encoders":"text_encoders",
            "vae":"vae",
            "loras":"loras",
            "upscale_models":"upscale_models",
            "checkpoints":"checkpoints",
        }}),
    )?;
    file.flush()?;
    file.as_file().sync_all()?;
    file.persist(&path)
        .map_err(|error| ApiError::from(error.error))?;
    Ok(path)
}
