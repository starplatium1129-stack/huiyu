mod config;
pub(crate) use config::is_valid_voice_id;
mod http;
pub use http::router;
pub(crate) mod muse;
mod native;
mod payload;
mod queue;
mod speech;
pub(crate) use speech::{is_pcm_wave, pcm_video_frames};
mod translation;

use crate::{
    AppState,
    config::Config,
    error::{ApiError, Result},
    upstream::{HealthProbes, LocalUpstream},
};
use config::Settings;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::time::Instant as Deadline;
use tokio_util::sync::CancellationToken;

pub struct VoiceService {
    speech: Arc<speech::Speech>,
    translation: Arc<translation::Translation>,
    shutdown: CancellationToken,
    probes: Arc<HealthProbes>,
}

#[derive(Default)]
pub(crate) struct ChannelSpeech<'a> {
    pub japanese: Option<&'a str>,
    pub emotion: Option<&'a str>,
    pub reference_emotion: Option<&'a str>,
    pub consistency: Option<&'a str>,
    pub speed: Option<f64>,
}

pub(crate) fn is_kana(ch: char) -> bool {
    matches!(ch, '\u{3041}'..='\u{3096}' | '\u{30A1}'..='\u{30F6}')
}

impl VoiceService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        Self::with_settings(Settings::load(config), shutdown)
    }
    fn with_settings(settings: Settings, shutdown: CancellationToken) -> Self {
        let settings = Arc::new(settings);
        let transport = LocalUpstream::new();
        let probes = HealthProbes::new(transport.clone(), shutdown.clone());
        let translation = translation::Translation::new(
            settings.clone(),
            transport.clone(),
            shutdown.clone(),
            probes.clone(),
        );
        let speech = speech::Speech::new(
            settings,
            transport,
            shutdown.clone(),
            probes.clone(),
            translation.clone(),
        );
        translation.bind_native(&speech.native);
        Self {
            speech,
            translation,
            shutdown,
            probes,
        }
    }
    pub fn queue_status(&self) -> Value {
        let queue = self.speech.queue.status();
        json!({"running": queue["active"].as_u64().unwrap_or(0) > 0, "pending": queue["pending"]})
    }
    pub(crate) fn translation_owned(&self) -> bool {
        self.translation.owned()
    }
    pub(crate) fn health_probes(&self) -> &Arc<HealthProbes> {
        &self.probes
    }
    pub(crate) async fn translation_status(&self, fresh: bool) -> Value {
        self.translation.status(fresh).await
    }
    pub(crate) async fn prepare_translation(&self) -> Result<()> {
        self.translation
            .prepare(Deadline::now() + Duration::from_secs(200))
            .await
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        self.speech.close();
        self.speech.native.close().await;
        self.translation.close().await;
        self.probes.close().await;
    }
    pub(crate) fn bind_control(&self, control: &Arc<crate::control::ControlService>) {
        self.speech.native.bind_control(control);
    }
    pub(crate) fn reload(&self, config: &Config) {
        let next = Arc::new(Settings::load(config));
        self.speech.update_settings(next.clone());
        self.translation.update_settings(next);
        self.probes.invalidate();
    }
    pub(crate) fn engine_id(&self) -> &'static str {
        self.speech.current_settings().engine.id()
    }
    pub(crate) fn speech_requires_japanese(&self) -> bool {
        self.speech.current_settings().needs_translation()
    }
    pub(crate) fn openai_configured(&self) -> bool {
        self.speech.current_settings().openai.configured()
    }
    pub(crate) fn native_files_present(&self) -> bool {
        self.speech.native.files_present()
    }

    pub(crate) fn resolve_catalog_voice(&self, catalog_id: &str) -> Option<String> {
        self.speech
            .current_settings()
            .resolve_voice_for_catalog(catalog_id)
    }
    pub(crate) async fn test_openai_tts(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        voice: &str,
        response_format: &str,
        text: &str,
    ) -> Result<(Vec<u8>, String)> {
        let mut settings = Settings {
            engine: config::Engine::OpenAiTts,
            tts_host: self.speech.current_settings().tts_host.clone(),
            openai: config::OpenAiTtsConfig {
                base_url: base_url.trim().trim_end_matches('/').to_owned(),
                api_key: api_key.trim().to_owned(),
                model: model.trim().to_owned(),
                voice_nene: voice.trim().to_owned(),
                voice_natsume: voice.trim().to_owned(),
                default_voice: voice.trim().to_owned(),
                response_format: response_format.to_owned(),
            },
            profiles: Default::default(),
            translation_url: String::new(),
            translation_port: 0,
            python: Default::default(),
            script: Default::default(),
            log: Default::default(),
            native_python: Default::default(),
            native_source: Default::default(),
            native_config: Default::default(),
            native_script: Default::default(),
            native_temp: Default::default(),
            native_log: Default::default(),
        };
        if !settings.openai.configured() {
            return Err(ApiError::invalid("请填写语音接口地址和模型名称"));
        }
        if settings.openai.response_format.is_empty() {
            settings.openai.response_format = "mp3".into();
        }
        let validated = payload::validate(
            &json!({"voice":"nene","language":"zh","text":text}),
            &settings,
        )?;
        let deadline = Deadline::now() + Duration::from_secs(25);
        self.speech
            .synthesize_openai(&settings, &validated.payload, deadline)
            .await
    }
    pub(crate) fn native_selected(&self) -> bool {
        self.speech.current_settings().engine == config::Engine::GptSoVitsNative
    }
    pub(crate) fn native_ready(&self) -> bool {
        self.speech.native.ready()
    }
    pub(crate) async fn retire_native(&self) -> Result<()> {
        if self.native_selected() || self.native_ready() {
            let idle = Arc::new(self.speech.queue.try_idle()?);
            self.speech.native.retire(idle).await?;
        }
        Ok(())
    }
    pub(crate) async fn start_native(&self) -> Result<()> {
        let settings = self.speech.current_settings();
        let voice = settings
            .voice_ids()
            .into_iter()
            .find(|id| {
                settings.profiles.get(id).is_some_and(|profile| {
                    profile.configured()
                        && !profile.gpt_weights_path.is_empty()
                        && !profile.sovits_weights_path.is_empty()
                })
            })
            .ok_or_else(|| ApiError::new(409, "VOICE_UNCONFIGURED", "请先配置角色声线"))?;
        let value = payload::validate(&json!({"voice":voice,"text":"準備"}), &settings)?;
        self.speech
            .prepare(&value, Deadline::now() + Duration::from_secs(200))
            .await
    }
    fn running(&self, state: &AppState) -> Result<()> {
        state.host.check_running()?;
        if self.shutdown.is_cancelled() {
            return Err(queue::cancelled());
        }
        Ok(())
    }

    pub(crate) async fn synthesize_channel_mp3(
        &self,
        state: &AppState,
        text: &str,
        voice: &str,
        options: ChannelSpeech<'_>,
        cancel: &CancellationToken,
    ) -> Result<axum::body::Bytes> {
        self.running(state)?;
        let raw: String = text.trim().chars().take(500).collect();
        if raw.is_empty() {
            return Err(ApiError::invalid("语音台词不能为空"));
        }
        let settings = self.speech.current_settings();
        match settings.engine {
            config::Engine::Off => {
                return Err(ApiError::new(
                    409,
                    "VOICE_DISABLED",
                    "语音功能已关闭，请先在控制面板「语音设置」启用云端语音接口或本机角色语音。",
                ));
            }
            config::Engine::System => {
                return Err(ApiError::new(
                    409,
                    "VOICE_CLIENT_SIDE",
                    "QQ 语音不支持浏览器系统朗读，请在控制面板「语音设置」改用云端语音接口或本机角色语音。",
                ));
            }
            config::Engine::OpenAiTts if !settings.openai.configured() => {
                return Err(ApiError::new(
                    409,
                    "VOICE_UNCONFIGURED",
                    "请先在控制面板「语音设置」填好云端语音接口与模型。",
                ));
            }
            _ => {}
        }
        let emotion = options
            .emotion
            .filter(|value| payload::EMOTIONS.contains(value))
            .unwrap_or("neutral");
        let reference_emotion = options
            .reference_emotion
            .filter(|value| emotion != "neutral" && payload::EMOTIONS.contains(value))
            .unwrap_or(emotion);
        let consistency = options
            .consistency
            .filter(|value| *value == "adaptive")
            .unwrap_or("locked");
        let deadline = Deadline::now() + Duration::from_secs(120);
        let work = async {
            let started = Deadline::now();
            let (spoken, language, source) = if settings.needs_translation() {
                let kana_count = raw.chars().filter(|&ch| is_kana(ch)).count();
                let all_kana =
                    kana_count > 0 && raw.chars().all(|ch| !ch.is_alphabetic() || is_kana(ch));
                let japanese = options
                    .japanese
                    .map(str::trim)
                    .filter(|text| text.chars().any(is_kana));
                if let Some(japanese) = japanese {
                    (japanese.chars().take(500).collect(), "ja", "chat")
                } else if kana_count >= 3 || all_kana {
                    (raw, "ja", "input")
                } else {
                    let result = self.translation.translate(raw, deadline).await?;
                    let translated = result["translation"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| {
                            ApiError::new(503, "VOICE_TRANSLATION_FAILED", "语音日语翻译结果为空")
                        })?
                        .to_owned();
                    (translated, "ja", "local-translation")
                }
            } else {
                (raw, "zh", "input")
            };
            let value = payload::validate(
                &json!({
                    "text": spoken,
                    "voice": voice,
                    "language": language,
                    "emotion": emotion,
                    "referenceEmotion": reference_emotion,
                    "consistency": consistency,
                    "speed": options.speed,
                }),
                &settings,
            )?;
            let speech_started = Deadline::now();
            let (bytes, mime, cached) = self.speech.buffered(value, deadline).await?;
            let audio = muse::encode_mp3(bytes, &mime).await?;
            let reference = if consistency == "adaptive" {
                emotion
            } else {
                reference_emotion
            };
            eprintln!(
                "QQ 语音已合成：voice={voice} emotion={emotion} reference={reference} source={source} cached={cached} prepare_ms={} speech_ms={}",
                (speech_started - started).as_millis(),
                speech_started.elapsed().as_millis(),
            );
            Ok(audio)
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(ApiError::new(499, "ABORT_ERR", "语音合成已停止")),
            _ = self.shutdown.cancelled() => Err(queue::cancelled()),
            result = tokio::time::timeout_at(deadline, work) => result
                .map_err(|_| ApiError::new(504, "VOICE_TIMEOUT", "语音合成超时，请稍后重试"))?,
        }
    }
}
