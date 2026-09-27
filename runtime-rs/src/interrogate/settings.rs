use crate::config::Config;
use std::{env, path::PathBuf};

#[derive(Clone)]
pub(super) struct Settings {
    pub models: Vec<PathBuf>,
    pub ort: PathBuf,
    pub vips: PathBuf,
    pub sd: String,
    pub comfy: String,
    pub comfy_input: PathBuf,
}
impl Settings {
    pub fn new(config: &Config) -> Self {
        let mut models = Vec::new();
        if let Some(path) = env::var_os("AICS_WD14_MODEL_DIR") {
            models.push(PathBuf::from(path));
        }
        for relative in [
            "ComfyUI/custom_nodes/ComfyUI-WD14-Tagger/models",
            "ComfyUI/models/tagger",
            "stable-diffusion-webui/models/WD14_tagger",
        ] {
            models.push(config.ai_workspace_root.join(relative));
        }
        models.push(config.app_root.join("runtime/models/interrogate"));
        #[cfg(windows)]
        let ort = "onnxruntime.dll";
        #[cfg(target_os = "macos")]
        let ort = "libonnxruntime.dylib";
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let ort = "libonnxruntime.so";
        Self {
            models,
            ort: env::var_os("AICS_ORT_DYLIB_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| config.app_root.join("native").join(ort)),
            vips: crate::native_images::library_path(config),
            sd: config.sd_host.clone(),
            comfy: config.comfy_host.clone(),
            comfy_input: config.ai_workspace_root.join("ComfyUI/input"),
        }
    }
}
