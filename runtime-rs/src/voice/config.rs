use crate::{config::Config, upstream::local_url};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, env, path::PathBuf, sync::Arc};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Reference {
    #[serde(default)]
    pub ref_audio_path: String,
    #[serde(default)]
    pub prompt_text: String,
    #[serde(default)]
    pub prompt_lang: String,
}
#[derive(Clone, Default, Deserialize)]
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

#[derive(Clone, Debug, Default)]
pub(super) struct OpenAiTtsConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub voice_nene: String,
    pub voice_natsume: String,
    pub default_voice: String,
    pub response_format: String,
}
impl OpenAiTtsConfig {
    pub fn configured(&self) -> bool {
        !self.base_url.is_empty() && !self.model.is_empty()
    }
    pub fn voice_for(&self, id: &str) -> &str {
        let specific = match id {
            "nene" => self.voice_nene.as_str(),
            "natsume" => self.voice_natsume.as_str(),
            _ => "",
        };
        if !specific.is_empty() {
            specific
        } else if !self.default_voice.is_empty() {
            &self.default_voice
        } else {
            "alloy"
        }
    }
    pub fn mime_type(&self) -> &'static str {
        match self.response_format.as_str() {
            "wav" => "audio/wav",
            "opus" => "audio/ogg",
            "aac" => "audio/aac",
            _ => "audio/mpeg",
        }
    }
}
fn parse_openai_tts(value: &Value) -> OpenAiTtsConfig {
    let base_url = value["baseUrl"]
        .as_str()
        .map(str::trim)
        .filter(|s| {
            url::Url::parse(s)
                .ok()
                .is_some_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
        })
        .map(|s| s.trim_end_matches('/').to_owned())
        .unwrap_or_default();
    let format = value["responseFormat"]
        .as_str()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| matches!(s.as_str(), "mp3" | "wav" | "opus" | "aac"))
        .unwrap_or_else(|| "mp3".into());
    OpenAiTtsConfig {
        base_url,
        api_key: value["apiKey"].as_str().unwrap_or("").trim().to_owned(),
        model: value["model"].as_str().unwrap_or("").trim().to_owned(),
        voice_nene: value["voiceNene"].as_str().unwrap_or("").trim().to_owned(),
        voice_natsume: value["voiceNatsume"].as_str().unwrap_or("").trim().to_owned(),
        default_voice: value["defaultVoice"].as_str().unwrap_or("").trim().to_owned(),
        response_format: format,
    }
}

pub(super) struct Settings {
    pub engine: Engine,
    pub tts_host: String,
    pub openai: OpenAiTtsConfig,
    pub profiles: HashMap<String, Arc<Profile>>,
    pub translation_url: String,
    pub translation_port: u16,
    pub python: PathBuf,
    pub script: PathBuf,
    pub log: PathBuf,
    pub native_python: PathBuf,
    pub native_source: PathBuf,
    pub native_config: PathBuf,
    pub native_script: PathBuf,
    pub native_temp: PathBuf,
    pub native_log: PathBuf,
}
impl Settings {
    pub fn needs_translation(&self) -> bool {
        matches!(
            self.engine,
            Engine::GptSoVits | Engine::GptSoVitsNative | Engine::VoxCpm2
        )
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Engine {
    Off,
    System,
    OpenAiTts,
    GptSoVits,
    GptSoVitsNative,
    VoxCpm2,
}
impl Engine {
    pub fn id(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::System => "system",
            Self::OpenAiTts => "openai-tts",
            Self::GptSoVits => "gpt-sovits",
            Self::GptSoVitsNative => "gpt-sovits-native",
            Self::VoxCpm2 => "voxcpm2",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "已关闭",
            Self::System => "系统朗读",
            Self::OpenAiTts => "语音接口（OpenAI 兼容）",
            Self::GptSoVits => "GPT-SoVITS",
            Self::GptSoVitsNative => "GPT-SoVITS（本机）",
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
        let profiles: HashMap<String, Arc<Profile>> = saved["voices"]
            .as_object()
            .map(|voices| {
                voices
                    .iter()
                    .filter_map(|(id, value)| {
                        Profile::deserialize(value)
                            .ok()
                            .map(|profile| (id.clone(), Arc::new(profile)))
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
        let has_local_profiles = profiles.values().any(|profile| profile.configured());
        let engine = match saved["ttsEngine"].as_str() {
            Some("off") => Engine::Off,
            Some("system") => Engine::System,
            Some("openai-tts") => Engine::OpenAiTts,
            Some("voxcpm2") => Engine::VoxCpm2,
            Some("gpt-sovits-native") => Engine::GptSoVitsNative,
            Some("gpt-sovits") => Engine::GptSoVits,
            _ if has_local_profiles => Engine::GptSoVits,
            _ => Engine::System,
        };
        Self {
            engine,
            tts_host,
            openai: parse_openai_tts(&saved["ttsApi"]),
            profiles,
            translation_port,
            translation_url: format!("http://127.0.0.1:{translation_port}"),
            python: env::var_os("TRANSLATION_PYTHON")
                .map(PathBuf::from)
                .unwrap_or_else(|| ai_root.join("GPT-SoVITS-env/python.exe")),
            script: tools.join("translate-zh-ja.py"),
            log: runtime.join("logs/translate.log"),
            native_python: ai_root.join("GPT-SoVITS-env/python.exe"),
            native_source: ai_root.join("GPT-SoVITS"),
            native_config: ai_root.join("Voice/config/tts_infer.yaml"),
            native_script: tools.join("voice/native_gpt_sovits.py"),
            native_temp: runtime.join("temp/voice"),
            native_log: runtime.join("logs/voice-native.log"),
        }
    }
}
