use crate::{config::Config, upstream::local_url};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, env, path::PathBuf, sync::Arc};

pub(crate) fn is_valid_voice_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'_' | b'-'))
        })
}

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
    pub display_name: String,
    #[serde(default)]
    pub catalog_id: String,
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

    pub fn native_files_present(&self) -> bool {
        self.configured()
            && [
                &self.gpt_weights_path,
                &self.sovits_weights_path,
                &self.reference.ref_audio_path,
            ]
            .iter()
            .all(|path| std::path::Path::new(path).is_file())
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

    pub fn voice_ids(&self) -> Vec<String> {
        let mut extra: Vec<String> = self
            .profiles
            .keys()
            .filter(|id| !matches!(id.as_str(), "nene" | "natsume") && is_valid_voice_id(id))
            .cloned()
            .collect();
        extra.sort();
        let mut ids = vec!["nene".to_owned(), "natsume".to_owned()];
        ids.extend(extra);
        ids
    }

    pub fn voice_labels(&self) -> HashMap<String, String> {
        let mut labels = HashMap::new();
        for id in self.voice_ids() {
            let custom = self
                .profiles
                .get(&id)
                .map(|profile| profile.display_name.trim())
                .filter(|name| !name.is_empty());
            let label = match custom {
                Some(name) => name.to_owned(),
                None => match id.as_str() {
                    "nene" => "绫地宁宁".to_owned(),
                    "natsume" => "四季夏目".to_owned(),
                    "roxy" => "洛琪希".to_owned(),
                    _ => id.clone(),
                },
            };
            labels.insert(id, label);
        }
        labels
    }

    fn profile_available(&self, profile: &Profile) -> bool {
        match self.engine {
            Engine::GptSoVitsNative => profile.native_files_present(),
            Engine::VoxCpm2 => profile.configured() && !profile.lora_weights_path.is_empty(),
            _ => profile.configured(),
        }
    }

    pub fn voice_catalog_map(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for (id, profile) in &self.profiles {
            if !is_valid_voice_id(id) || !self.profile_available(profile) {
                continue;
            }
            let explicit = profile.catalog_id.trim();
            if !explicit.is_empty() {
                map.insert(explicit.to_owned(), id.clone());
            } else if id == "roxy" {
                map.insert("roxy_migurdia".to_owned(), id.clone());
            }
            map.entry(id.clone()).or_insert_with(|| id.clone());
        }
        map
    }

    pub fn resolve_voice_for_catalog(&self, catalog_id: &str) -> Option<String> {
        let catalog_id = catalog_id.trim();
        if catalog_id.is_empty() {
            return None;
        }
        if let Some(profile) = self.profiles.get(catalog_id)
            && self.profile_available(profile)
        {
            return Some(catalog_id.to_owned());
        }
        if let Some((id, _)) = self.profiles.iter().find(|(id, profile)| {
            is_valid_voice_id(id)
                && self.profile_available(profile)
                && (profile.catalog_id.trim() == catalog_id
                    || (catalog_id == "roxy_migurdia" && id.as_str() == "roxy"))
        }) {
            return Some(id.clone());
        }
        let mut prefix_matches = self.profiles.iter().filter(|(id, profile)| {
            is_valid_voice_id(id)
                && self.profile_available(profile)
                && catalog_id
                    .strip_prefix(id.as_str())
                    .is_some_and(|rest| rest.starts_with('_'))
        });
        let first = prefix_matches.next()?.0.clone();
        prefix_matches.next().is_none().then_some(first)
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
                        is_valid_voice_id(id)
                            .then(|| Profile::deserialize(value).ok())
                            .flatten()
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
