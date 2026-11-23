use super::{config::Engine, payload, queue};
use crate::{
    AppState,
    error::{ApiError, Result},
    generation::receipts::valid_request_key,
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::ErrorKind, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Semaphore,
    time::Instant,
};

// Leaves room in both 2 MiB relay envelopes for Base64 and JSON metadata.
const MAX_AUDIO: usize = 1_400_000;
static SLOTS: Semaphore = Semaphore::const_new(2);

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/muse/voice/status", get(status))
        .route("/api/muse/voice/synthesize", post(synthesize))
        .layer(DefaultBodyLimit::max(64 * 1024))
}

async fn status(State(state): State<AppState>) -> Result<Json<Value>> {
    state.host.check_running()?;
    let mut result = json!({"ok":true, "online":false, "available":false, "engineId":"off",
        "engine":Engine::Off.label(), "voices":{"nene":false,"natsume":false}, "formats":["mp3","wav"]});
    if let Some(service) = &state.voice {
        service.running(&state)?;
        let observed = service.speech.status_observed(false).await;
        let id = &observed["engineId"];
        result["engineId"] = id.clone();
        result["engine"] = observed["engine"].clone();
        if !matches!(id.as_str(), Some("off" | "system")) {
            let voices = &observed["voices"];
            // A configured native model can serve its first request from cold.
            let reachable = observed.get("available").unwrap_or(&observed["online"]) == true;
            result["online"] = json!(reachable);
            result["available"] =
                json!(reachable && (voices["nene"] == true || voices["natsume"] == true));
            result["voices"] = voices.clone();
        }
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    request_key: String,
    text: String,
    voice: Option<String>,
    language: Option<String>,
    emotion: Option<String>,
    reference_emotion: Option<String>,
    consistency: Option<String>,
    speed: Option<f64>,
    format: Option<String>,
}

async fn synthesize(State(state): State<AppState>, Json(input): Json<Input>) -> Result<Response> {
    state.host.check_running()?;
    let service = state
        .voice
        .as_ref()
        .ok_or_else(|| ApiError::new(409, "VOICE_DISABLED", "语音服务未启用"))?;
    service.running(&state)?;
    if !valid_request_key(&input.request_key) {
        return Err(ApiError::invalid("语音请求编号无效"));
    }
    if !(1..=500).contains(&input.text.trim().chars().count()) {
        return Err(ApiError::new(
            400,
            "VOICE_TEXT_TOO_LONG",
            "台词长度须为 1 至 500 字",
        ));
    }
    let voice = input.voice.as_deref().unwrap_or("nene");
    let emotion = input.emotion.as_deref().unwrap_or("gentle");
    let reference = input.reference_emotion.as_deref().unwrap_or(emotion);
    let format = input.format.as_deref().unwrap_or("mp3");
    let consistency = input.consistency.as_deref().unwrap_or("locked");
    if input.language.as_deref().unwrap_or("ja") != "ja"
        || !payload::EMOTIONS.contains(&emotion)
        || !payload::EMOTIONS.contains(&reference)
        || !matches!(format, "wav" | "mp3")
        || !matches!(consistency, "adaptive" | "locked")
    {
        return Err(ApiError::new(
            400,
            "VOICE_INVALID",
            "请使用日语、支持的情绪和 MP3 或 WAV 格式",
        ));
    }
    let Ok(_slot) = SLOTS.try_acquire() else {
        return Ok((
            [(header::RETRY_AFTER, "3")],
            ApiError::new(429, "MUSE_VOICE_BUSY", "远程语音正在忙"),
        )
            .into_response());
    };
    let started = Instant::now();
    let deadline = started + Duration::from_secs(80);
    let settings = service.speech.current_settings();
    let value = payload::validate(
        &json!({"text":input.text, "voice":voice, "language":"ja",
        "emotion":emotion, "referenceEmotion":reference, "consistency":consistency, "speed":input.speed}),
        &settings,
    )?;
    let (bytes, mime, cached) =
        service
            .speech
            .buffered(value, deadline)
            .await
            .map_err(|mut err| {
                // Provider diagnostics may include private paths, prompts or upstream URLs.
                if err.status.is_server_error() || err.code == "TTS_FAILED" {
                    err.message = "主力机语音合成失败".into();
                }
                err
            })?;
    let (audio, mime) = tokio::select! {
        biased;
        _ = service.shutdown.cancelled() => return Err(queue::cancelled()),
        _ = tokio::time::sleep_until(deadline) => return Err(queue::speech_timeout()),
        result = encode(bytes, &mime, format) => result?,
    };
    Ok(Json(json!({"ok":true, "requestKey":input.request_key, "engineId":settings.engine.id(),
        "voice":voice, "language":"ja", "emotion":emotion, "mimeType":mime, "bytes":audio.len(),
        "sha256":hex::encode(Sha256::digest(&audio)), "cached":cached, "elapsedMs":started.elapsed().as_millis(),
        "data":STANDARD.encode(audio)})).into_response())
}

fn too_large() -> ApiError {
    ApiError::new(413, "VOICE_AUDIO_TOO_LARGE", "音频超过中转限制，请缩短台词")
}

pub(super) async fn encode_mp3(bytes: Bytes, mime: &str) -> Result<Bytes> {
    let (audio, output_mime) = encode(bytes, mime, "mp3").await?;
    if output_mime != "audio/mpeg" {
        return Err(ApiError::new(
            503,
            "VOICE_FFMPEG_REQUIRED",
            "本机缺少 ffmpeg，无法将语音转为 QQ 支持的 MP3 格式",
        ));
    }
    Ok(audio)
}

async fn encode(bytes: Bytes, mime: &str, format: &str) -> Result<(Bytes, &'static str)> {
    let source = match mime {
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" | "audio/opus" => "ogg",
        "audio/aac" => "aac",
        _ => {
            return Err(ApiError::new(
                502,
                "VOICE_FORMAT_INVALID",
                "不支持的上游音频格式",
            ));
        }
    };
    let output_mime = if format == "mp3" {
        "audio/mpeg"
    } else {
        "audio/wav"
    };
    if format == source && bytes.len() <= MAX_AUDIO {
        return Ok((bytes, output_mime));
    }
    if format == source && format == "wav" {
        return Err(too_large());
    }
    let mut command = Command::new("ffmpeg");
    command.args([
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "pipe",
        "-f",
        source,
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-map_metadata",
        "-1",
        "-ar",
        "24000",
        "-ac",
        "1",
    ]);
    let container = if format == "mp3" {
        command.args(["-c:a", "libmp3lame", "-b:a", "64k"]);
        "mp3"
    } else {
        // A pipe cannot seek back to finish a WAV header. Frame the bounded
        // PCM output here so saved WAVs have the real sample length.
        "s16le"
    };
    command
        .args(["-f", container, "pipe:1"])
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let failed = || ApiError::new(502, "VOICE_TRANSCODE_FAILED", "主力机音频转码失败");
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == ErrorKind::NotFound && source == "wav" => {
            return if bytes.len() <= MAX_AUDIO {
                Ok((bytes, "audio/wav"))
            } else {
                Err(too_large())
            };
        }
        Err(_) => return Err(failed()),
    };
    let mut stdin = child.stdin.take().ok_or_else(failed)?;
    let stdout = child.stdout.take().ok_or_else(failed)?;
    let mut output = if format == "wav" {
        payload::pcm_wave_header(24000)
    } else {
        Vec::new()
    };
    let header_size = output.len();
    // Drain stdout while feeding stdin; both OS pipes are smaller than a sentence.
    tokio::try_join!(
        async move {
            stdin.write_all(&bytes).await.map_err(|_| failed())?;
            drop(stdin);
            Ok(())
        },
        async {
            stdout
                .take((MAX_AUDIO - header_size + 1) as u64)
                .read_to_end(&mut output)
                .await
                .map_err(|_| failed())?;
            if output.len() > MAX_AUDIO {
                return Err(too_large());
            }
            Ok(())
        }
    )?;
    if !child.wait().await.map_err(|_| failed())?.success() || output.len() <= header_size {
        return Err(failed());
    }
    if format == "wav" {
        let total = output.len() as u32;
        output[4..8].copy_from_slice(&(total - 8).to_le_bytes());
        output[40..44].copy_from_slice(&(total - 44).to_le_bytes());
    }
    Ok((output.into(), output_mime))
}
