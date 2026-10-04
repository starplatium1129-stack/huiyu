use crate::{config::Config, upstream::local_url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, env, path::PathBuf};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Reference {
    #[serde(default)]
    pub ref_audio_path: String,
    #[serde(default)]
    pub prompt_text: String,
    #[serde(default)]
    pub prompt_lang: String,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Profile {
    #[serde(flatten)]
    pub reference: Reference,
    #[serde(default)]
    pub gpt_weights_path: String,
    #[serde(default)]
    pub sovits_weights_path: String,
    #[serde(default)]
    pub lora_weights_path: String,
    pub seed: Option<f64>,
    pub top_k: Option<f64>,
    pub top_p: Option<f64>,
    pub temperature: Option<f64>,
    #[serde(default)]
    pub references: HashMap<String, Reference>,
}
impl Profile {
    pub fn configured(&self) -> bool {
        !self.reference.ref_audio_path.is_empty() && !self.reference.prompt_text.is_empty()
    }
}

#[derive(Clone)]
pub(super) struct Settings {
    pub engine: Engine,
    pub tts_host: String,
    pub profiles: HashMap<String, Profile>,
    pub translation_url: String,
    pub translation_port: u16,
    pub python: PathBuf,
    pub script: PathBuf,
    pub log: PathBuf,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Engine {
    GptSoVits,
    VoxCpm2,
}
impl Engine {
    pub fn id(self) -> &'static str {
        match self {
            Self::GptSoVits => "gpt-sovits",
            Self::VoxCpm2 => "voxcpm2",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::GptSoVits => "GPT-SoVITS",
            Self::VoxCpm2 => "VoxCPM2",
        }
    }
}
impl Settings {
    pub fn load(config: &Config) -> Self {
        let root = &config.app_root;
        let runtime = &config.runtime_root;
        let saved: Value = std::fs::read(runtime.join("config.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let supplied = env::var("TTS_HOST").ok();
        let tts_host = supplied
            .as_deref()
            .into_iter()
            .chain(saved["ttsHost"].as_str())
            .find_map(|value| local_url(value).ok())
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_else(|| "http://127.0.0.1:9880".into());
        let profiles = saved["voices"]
            .as_object()
            .map(|voices| {
                voices
                    .iter()
                    .filter_map(|(id, value)| {
                        serde_json::from_value(value.clone())
                            .ok()
                            .map(|profile| (id.clone(), profile))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let translation_port = env::var("TRANSLATE_PORT")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite())
            .map(|n| n.round().clamp(1024.0, 65535.0) as u16)
            .unwrap_or(5310);
        let ai_root = &config.ai_workspace_root;
        let tools = env::var_os("AICS_TOOLS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("tools"));
        Self {
            engine: if saved["ttsEngine"] == "voxcpm2" {
                Engine::VoxCpm2
            } else {
                Engine::GptSoVits
            },
            tts_host,
            profiles,
            translation_port,
            translation_url: format!("http://127.0.0.1:{translation_port}"),
            python: env::var_os("TRANSLATION_PYTHON")
                .map(PathBuf::from)
                .unwrap_or_else(|| ai_root.join("GPT-SoVITS-env/python.exe")),
            script: tools.join("translate-zh-ja.py"),
            log: runtime.join("logs/translate.log"),
        }
    }
}
