use super::config::{Engine, Profile, Settings};
use crate::error::{ApiError, Result};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    sync::{Arc, LazyLock},
};
use unicode_normalization::UnicodeNormalization;

const EMOTIONS: &[&str] = &["neutral", "gentle", "happy", "shy", "serious", "sad"];
static JAPANESE_REPLACEMENTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"绫地宁宁|綾地寧々|綾地寧寧|四季夏目|四季ナツメ|\.\.\.").unwrap());
pub(super) struct Validated {
    pub voice: String,
    pub profile: Arc<Profile>,
    pub payload: Value,
}
fn field<'a>(input: &'a Value, name: &str, fallback: &'a str) -> &'a str {
    input[name]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
}
fn numeric(value: Option<f64>, default: f64, min: f64, max: f64, round: bool) -> f64 {
    let value = value.filter(|v| v.is_finite()).unwrap_or(default);
    (if round { value.round() } else { value }).clamp(min, max)
}
pub(super) fn validate(input: &Value, settings: &Settings) -> Result<Validated> {
    let voice = field(input, "voice", "");
    let language = field(input, "language", "ja").to_lowercase();
    let raw = field(input, "text", "").trim();
    if !["nene", "natsume"].contains(&voice) {
        return Err(ApiError::new(400, "VOICE_INVALID", "不支持的角色声线"));
    }
    if !["ja", "zh"].contains(&language.as_str()) {
        return Err(ApiError::new(
            400,
            "VOICE_INVALID",
            "语音语言仅支持日语或中文",
        ));
    }
    if raw.is_empty() || raw.encode_utf16().count() > 2000 {
        return Err(ApiError::new(
            400,
            "VOICE_INVALID",
            "台词长度必须在 1—2000 字之间",
        ));
    }
    let profile = settings
        .profiles
        .get(voice)
        .filter(|profile| {
            profile.configured()
                && (settings.engine != Engine::VoxCpm2 || !profile.lora_weights_path.is_empty())
        })
        .ok_or_else(|| {
            ApiError::new(
                409,
                "VOICE_UNCONFIGURED",
                "该角色尚未配置当前语音引擎的声线和参考音频",
            )
        })?
        .clone();
    let mut emotion = field(input, "emotion", "neutral").to_lowercase();
    if !EMOTIONS.contains(&emotion.as_str()) {
        emotion = "neutral".into();
    }
    let mut reference = field(input, "referenceEmotion", &emotion).to_lowercase();
    if !EMOTIONS.contains(&reference.as_str()) {
        reference = emotion.clone();
    }
    let reference_key = if field(input, "consistency", "adaptive").eq_ignore_ascii_case("locked") {
        &reference
    } else {
        &emotion
    };
    let selected = if language == "ja" {
        profile.references.get(reference_key)
    } else {
        None
    };
    let choose = |name: fn(&super::config::Reference) -> &str| {
        selected
            .map(name)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| name(&profile.reference))
    };
    let text = normalize(raw, &language);
    if text.is_empty() {
        return Err(ApiError::new(400, "VOICE_INVALID", "台词规范化后为空"));
    }
    let prompt_lang = choose(|r| &r.prompt_lang);
    let speed = input["speed"]
        .as_f64()
        .or_else(|| input["speed"].as_str().and_then(|s| s.parse().ok()));
    // Installed GPT-SoVITS v2Pro/v2ProPlus rejects ordinary Japanese with cut0;
    // retain cut5 until an engine upgrade is verified with the same dialogue.
    let mut payload = json!({"text": null, "text_lang": null, "ref_audio_path": choose(|r| &r.ref_audio_path),
        "prompt_lang": if prompt_lang.is_empty() { "ja" } else { prompt_lang }, "prompt_text": choose(|r| &r.prompt_text),
        "text_split_method": "cut5", "batch_size": 1, "split_bucket": false, "speed_factor": numeric(speed, 1.0, 0.75, 1.35, false),
        "seed": numeric(profile.seed, 1234.0, 0.0, 2147483647.0, true) as i64,
        "top_k": numeric(profile.top_k, 15.0, 1.0, 100.0, true) as i64, "top_p": numeric(profile.top_p, 1.0, 0.1, 1.0, false),
        "temperature": numeric(profile.temperature, 1.0, 0.1, 2.0, false), "parallel_infer": false, "media_type": "wav", "streaming_mode": false});
    payload["text"] = text.into();
    payload["text_lang"] = language.into();
    if settings.engine == Engine::VoxCpm2 {
        payload["voice"] = voice.into();
        payload["lora_weights_path"] = profile.lora_weights_path.clone().into();
    }
    Ok(Validated {
        voice: voice.into(),
        profile,
        payload,
    })
}

pub(super) fn normalize(raw: &str, language: &str) -> String {
    let mut text = String::new();
    let mut space = false;
    // U+30FB is a silent emphasis separator that the Windows Japanese tokenizer
    // cannot log through its GBK console. Remove this workaround only after the
    // installed engine logs/tokenizes it successfully with UTF-8 end to end.
    for ch in raw.nfkc() {
        if matches!(ch, '\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}' | '\u{200b}'..='\u{200d}' | '\u{feff}' | '\u{30fb}')
        {
            continue;
        }
        if ch == '\n' {
            while text.ends_with(char::is_whitespace) {
                text.pop();
            }
            if !text.ends_with('。') {
                text.push('。');
            }
            space = true;
        } else if ch == ' ' || ch == '\t' {
            if !space {
                text.push(' ');
            }
            space = true;
        } else if ch == '。' && text.ends_with('。') {
            space = false;
        } else {
            text.push(ch);
            space = false;
        }
    }
    let leading = text.len() - text.trim_start().len();
    if leading > 0 {
        drop(text.drain(..leading));
    }
    text.truncate(text.trim_end().len());
    if language == "ja" {
        // Patterns neither overlap nor produce another pattern, so one pass
        // preserves the previous ordered replacements.
        if let Cow::Owned(replaced) =
            JAPANESE_REPLACEMENTS.replace_all(&text, |matched: &regex::Captures<'_>| match &matched
                [0]
            {
                "绫地宁宁" | "綾地寧々" | "綾地寧寧" => "あやち ねね",
                "四季夏目" | "四季ナツメ" => "しき なつめ",
                _ => "……",
            })
        {
            text = replaced;
        }
    }
    text
}

pub(super) fn pcm_wave_header(rate: u32) -> Vec<u8> {
    let mut wave = Vec::with_capacity(44);
    wave.extend_from_slice(b"RIFF");
    wave.extend_from_slice(&36u32.to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt ");
    wave.extend_from_slice(&16u32.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&rate.to_le_bytes());
    wave.extend_from_slice(&(rate * 2).to_le_bytes());
    wave.extend_from_slice(&2u16.to_le_bytes());
    wave.extend_from_slice(&16u16.to_le_bytes());
    wave.extend_from_slice(b"data");
    wave.extend_from_slice(&0u32.to_le_bytes());
    wave
}
