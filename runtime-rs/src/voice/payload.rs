use super::config::{Engine, Profile, Settings};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

const EMOTIONS: &[&str] = &["neutral", "gentle", "happy", "shy", "serious", "sad"];
pub(super) struct Validated {
    pub voice: String,
    pub profile: Profile,
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
            .to_owned()
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
    let mut payload = json!({"text": text, "text_lang": language, "ref_audio_path": choose(|r| &r.ref_audio_path),
        "prompt_lang": if prompt_lang.is_empty() { "ja" } else { &prompt_lang }, "prompt_text": choose(|r| &r.prompt_text),
        "text_split_method": "cut5", "batch_size": 1, "split_bucket": false, "speed_factor": numeric(speed, 1.0, 0.75, 1.35, false),
        "seed": numeric(profile.seed, 1234.0, 0.0, 2147483647.0, true) as i64,
        "top_k": numeric(profile.top_k, 15.0, 1.0, 100.0, true) as i64, "top_p": numeric(profile.top_p, 1.0, 0.1, 1.0, false),
        "temperature": numeric(profile.temperature, 1.0, 0.1, 2.0, false), "parallel_infer": false, "media_type": "wav", "streaming_mode": false});
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
    text = text.trim().to_owned();
    if language == "ja" {
        for name in ["绫地宁宁", "綾地寧々", "綾地寧寧"] {
            text = text.replace(name, "あやち ねね");
        }
        for name in ["四季夏目", "四季ナツメ"] {
            text = text.replace(name, "しき なつめ");
        }
        text = text.replace("...", "……");
    }
    text
}

pub(super) fn fix_wav(bytes: &mut [u8]) {
    if bytes.len() < 44 || bytes.get(..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return;
    }
    let length = bytes.len();
    bytes[4..8].copy_from_slice(&((length - 8) as u32).to_le_bytes());
    let mut offset = 12;
    while offset + 8 <= length {
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        if &bytes[offset..offset + 4] == b"data" {
            bytes[offset + 4..offset + 8]
                .copy_from_slice(&((length - offset - 8) as u32).to_le_bytes());
            break;
        }
        if size > length || offset + 8 + size > length + 1 {
            break;
        }
        offset += 8 + size + size % 2;
    }
}

pub(super) fn pcm_wave(pcm: &[u8], rate: u32) -> Vec<u8> {
    let mut wave = Vec::with_capacity(44 + pcm.len());
    wave.extend_from_slice(b"RIFF");
    wave.extend_from_slice(&((36 + pcm.len()) as u32).to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt ");
    wave.extend_from_slice(&16u32.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&rate.to_le_bytes());
    wave.extend_from_slice(&(rate * 2).to_le_bytes());
    wave.extend_from_slice(&2u16.to_le_bytes());
    wave.extend_from_slice(&16u16.to_le_bytes());
    wave.extend_from_slice(b"data");
    wave.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wave.extend_from_slice(pcm);
    wave
}
