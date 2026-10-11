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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn moved_workspace_maps_current_models_without_rewriting_existing_config() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old AI");
        let current = temp.path().join("current AI 宁宁");
        let config_path = ".runtimes/comfy/ComfyUI/extra_model_paths.yaml";
        let user_config = format!(
            "user_models:\n  base_path: {}\n  is_default: true\n  loras: loras\n",
            serde_json::to_string(&old.join("ComfyUI/models")).unwrap()
        );
        std::fs::create_dir_all(old.join(config_path).parent().unwrap()).unwrap();
        std::fs::write(old.join(config_path), &user_config).unwrap();
        std::fs::rename(&old, &current).unwrap();

        let runtime = temp.path().join("runtime");
        // The dedicated config may still describe the previous workspace.
        let old_mapping = create(&old, &runtime).unwrap();
        let path = create(&current, &runtime).unwrap();
        assert_eq!(path, old_mapping);
        let document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let models = &document["huiyu_models"];
        assert_eq!(models["base_path"], json!(current.join("ComfyUI/models")));
        assert_eq!(models["is_default"], true);
        for kind in [
            "diffusion_models",
            "text_encoders",
            "vae",
            "loras",
            "upscale_models",
            "checkpoints",
        ] {
            assert_eq!(models[kind], kind);
        }
        assert_eq!(
            std::fs::read_to_string(current.join(config_path)).unwrap(),
            user_config
        );
        assert!(path.starts_with(&runtime));
        assert_eq!(std::fs::read_dir(&runtime).unwrap().count(), 1);
    }
}
