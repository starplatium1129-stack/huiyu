use super::*;
use crate::security;
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::{HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::{collections::HashMap, net::SocketAddr, time::Instant};

pub fn router(service: Arc<VoiceService>) -> Router<AppState> {
    Router::new()
        .route("/api/translate", post(translate))
        .route("/api/tts-status", get(status))
        .route(
            "/api/voice/prepare",
            post(prepare).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route("/api/tts", get(get_audio).post(post_audio))
        .route("/api/tts-stream", get(get_pcm))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(Extension(service))
}

async fn translate(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    Json(input): Json<Value>,
) -> Result<Response> {
    let deadline = Deadline::now() + Duration::from_secs(200);
    service.running(&state)?;
    let text = input["text"].as_str().unwrap_or("").trim();
    if text.is_empty() || text.encode_utf16().count() > 2000 {
        return Err(ApiError::new(
            400,
            "TRANSLATION_INVALID",
            "待翻译中文需在 1—2000 字之间",
        ));
    }
    let result = service.translation.translate(text.into(), deadline).await?;
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TranslationBody<'a> {
        ok: bool,
        source_language: &'static str,
        target_language: &'static str,
        translation: &'a Value,
        segments: &'a Value,
    }
    let empty_segments = Value::Array(Vec::new());
    Ok(Json(TranslationBody {
        ok: true,
        source_language: "zh",
        target_language: "ja",
        translation: &result["translation"],
        segments: result.get("segments").unwrap_or(&empty_segments),
    })
    .into_response())
}
async fn status(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    service.running(&state)?;
    let fresh = query.get("fresh").is_some_and(|value| value == "1");
    if query.get("scope").is_some_and(|value| value == "room") {
        return Ok(Json(service.speech.status_observed(fresh).await));
    }
    let (mut result, translation) = tokio::join!(
        service.speech.status_observed(fresh),
        service.translation.status(fresh)
    );
    result["translation"] = translation;
    Ok(Json(result))
}
async fn prepare(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>> {
    let deadline = Deadline::now() + Duration::from_secs(200);
    service.running(&state)?;
    let voice = input["voice"].as_str().unwrap_or("");
    let settings = service.speech.current_settings();
    match settings.engine {
        config::Engine::Off | config::Engine::System => {
            return Ok(Json(
                json!({"ok": true, "voice": voice, "engineId": settings.engine.id(), "translation": false, "prepareMs": 0}),
            ));
        }
        config::Engine::OpenAiTts => {
            if !settings.openai.configured() {
                return Err(ApiError::new(
                    409,
                    "VOICE_UNCONFIGURED",
                    "请先在控制室「语音配置」填写语音接口地址与模型",
                ));
            }
            return Ok(Json(
                json!({"ok": true, "voice": voice, "engineId": settings.engine.id(), "translation": false, "prepareMs": 0}),
            ));
        }
        _ => {}
    }
    let value = payload::validate(&json!({"voice": voice, "text": "準備"}), &settings)?;
    // Native speech and managed translation share memory. Leave speech warm;
    // a request that needs translation can start it after retiring speech.
    let needs_translation =
        input["translation"] == true && settings.engine != config::Engine::GptSoVitsNative;
    let started = Instant::now();
    let translation = async {
        if needs_translation {
            service.translation.prepare(deadline).await?;
        }
        Ok::<_, ApiError>(())
    };
    tokio::try_join!(service.speech.prepare(&value, deadline), translation)?;
    Ok(Json(
        json!({"ok": true, "voice": voice, "engineId": settings.engine.id(), "translation": needs_translation, "prepareMs": started.elapsed().as_millis()}),
    ))
}
async fn post_audio(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Response> {
    let deadline = Deadline::now() + Duration::from_secs(240);
    service.running(&state)?;
    let settings = service.speech.current_settings();
    let value = payload::validate(&input, &settings)?;
    let mut response = service
        .speech
        .audio(value, deadline)
        .await
        .map_err(|error| tts_error(error, &headers, peer))?;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}
async fn get_audio(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    let deadline = Deadline::now() + Duration::from_secs(240);
    service.running(&state)?;
    if query
        .get("text")
        .is_some_and(|text| text.encode_utf16().count() > 1200)
    {
        return Err(ApiError::new(
            413,
            "VOICE_TEXT_TOO_LONG",
            "长文本请使用 POST /api/tts",
        ));
    }
    let input = serde_json::to_value(query).expect("String query serializes");
    let settings = service.speech.current_settings();
    let value = payload::validate(&input, &settings)?;
    let (bytes, content_type, cached) = service
        .speech
        .buffered(value, deadline)
        .await
        .map_err(|error| tts_error(error, &headers, peer))?;
    let mut response = (
        [
            ("cache-control", "no-store"),
            ("x-accel-buffering", "no"),
            ("x-tts-cache", if cached { "hit" } else { "miss" }),
        ],
        bytes,
    )
        .into_response();
    if let Ok(ct) = HeaderValue::from_str(&content_type) {
        response.headers_mut().insert("content-type", ct);
    } else {
        response
            .headers_mut()
            .insert("content-type", HeaderValue::from_static("audio/wav"));
    }
    Ok(response)
}
async fn get_pcm(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
    let deadline = Deadline::now() + Duration::from_secs(180);
    service.running(&state)?;
    let input = serde_json::to_value(query).expect("String query serializes");
    let settings = service.speech.current_settings();
    let value = payload::validate(&input, &settings)?;
    let mut response = service
        .speech
        .stream_pcm(value, deadline)
        .await
        .map_err(|error| tts_error(error, &headers, peer))?;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "access-control-expose-headers",
        HeaderValue::from_static("X-Audio-Sample-Rate, X-Audio-Channels, X-Audio-Format"),
    );
    Ok(response)
}

// Provider diagnostics can contain local filenames. Keep them inside the local
// studio boundary, including when buffered callers share an in-flight result.
fn tts_error(mut error: ApiError, headers: &HeaderMap, peer: SocketAddr) -> ApiError {
    if error.code == "TTS_FAILED" && !security::is_direct_local(headers, peer.ip()) {
        error.message = "语音生成失败".into();
    }
    error
}
