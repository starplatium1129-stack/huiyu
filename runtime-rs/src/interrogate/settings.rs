use super::pixai::Settings;
use crate::config::Config;
use serde::Deserialize;
use std::{env, fs, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    schema_version: u32,
    python: PathBuf,
    model_dir: PathBuf,
    deps_dir: PathBuf,
    torch_site_packages: PathBuf,
}

fn receipt(config: &Config) -> Option<Receipt> {
    // Startup configuration alone selects executable/model paths. An explicit
    // invalid receipt stays closed rather than searching a different library.
    let paths = if let Some(path) = env::var_os("AICS_PIXAI_CONFIG") {
        vec![PathBuf::from(path)]
    } else {
        vec![
            config.runtime_root.join("pixai/runtime-config.json"),
            config.ai_workspace_root.join("PixAI/runtime-config.json"),
        ]
    };
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let value: Receipt = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        if value.schema_version != 1
            || ![
                &value.python,
                &value.model_dir,
                &value.deps_dir,
                &value.torch_site_packages,
            ]
            .iter()
            .all(|path| path.is_absolute())
        {
            return None;
        }
        return Some(value);
    }
    None
}

pub(super) fn load(config: &Config) -> Settings {
    let root = config.runtime_root.join("pixai");
    let value = receipt(config);
    let selected = |name: &str, saved: Option<&PathBuf>, fallback: &str| {
        env::var_os(name)
            .map(PathBuf::from)
            .or_else(|| saved.cloned())
            .unwrap_or_else(|| root.join(fallback))
    };
    Settings {
        python: selected(
            "AICS_PIXAI_PYTHON",
            value.as_ref().map(|v| &v.python),
            "unconfigured/python.exe",
        ),
        model_dir: selected(
            "AICS_PIXAI_MODEL_DIR",
            value.as_ref().map(|v| &v.model_dir),
            "model",
        ),
        deps_dir: selected(
            "AICS_PIXAI_DEPS_DIR",
            value.as_ref().map(|v| &v.deps_dir),
            "deps",
        ),
        torch_site_packages: selected(
            "AICS_PIXAI_TORCH_SITE_PACKAGES",
            value.as_ref().map(|v| &v.torch_site_packages),
            "torch",
        ),
        script: config.app_root.join("tools/interrogate/pixai_worker.py"),
        temp_root: config.runtime_root.join("pixai/inputs"),
    }
}
