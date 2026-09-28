mod config;
mod payload;
mod queue;
mod speech;
mod translation;

use crate::{
    AppState,
    config::Config,
    error::{ApiError, Result},
    upstream::LocalUpstream,
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Query, State},
    http::HeaderValue,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use config::Settings;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Instant};
use tokio_util::sync::CancellationToken;

pub struct VoiceService {
    speech: Arc<speech::Speech>,
    translation: Arc<translation::Translation>,
    shutdown: CancellationToken,
}
impl VoiceService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        Self::with_settings(Settings::load(config), shutdown)
    }
    fn with_settings(settings: Settings, shutdown: CancellationToken) -> Self {
        let settings = Arc::new(settings);
        let transport = LocalUpstream::new();
        Self {
            speech: speech::Speech::new(settings.clone(), transport.clone(), shutdown.clone()),
            translation: translation::Translation::new(settings, transport, shutdown.clone()),
            shutdown,
        }
    }
    pub fn queue_status(&self) -> Value {
        let queue = self.speech.queue.status();
        json!({"running": queue["active"].as_u64().unwrap_or(0) > 0, "pending": queue["pending"]})
    }
    pub(crate) fn translation_owned(&self) -> bool {
        self.translation.owned()
    }
    pub(crate) async fn translation_status(&self) -> Value {
        self.translation.status().await
    }
    pub(crate) async fn prepare_translation(&self) -> Result<()> {
        self.translation.prepare().await
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        self.speech.close();
        self.translation.close().await;
    }
    fn running(&self, state: &AppState) -> Result<()> {
        state.host.check_running()?;
        if self.shutdown.is_cancelled() {
            return Err(queue::cancelled());
        }
        Ok(())
    }
}

pub fn router(service: Arc<VoiceService>) -> Router<AppState> {
    Router::new()
        .route("/api/translate", post(translate))
        .route("/api/tts-status", get(status))
        .route(
            "/api/voice/prepare",
            post(prepare).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route("/api/tts", get(get_audio).post(post_audio))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(Extension(service))
}

async fn translate(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>> {
    service.running(&state)?;
    let text = input["text"].as_str().unwrap_or("").trim();
    if text.is_empty() || text.encode_utf16().count() > 2000 {
        return Err(ApiError::new(
            400,
            "TRANSLATION_INVALID",
            "待翻译中文需在 1—2000 字之间",
        ));
    }
    let result = service.translation.translate(text.into()).await?;
    Ok(Json(
        json!({"ok": true, "sourceLanguage": "zh", "targetLanguage": "ja", "translation": result["translation"], "segments": result.get("segments").cloned().unwrap_or(json!([]))}),
    ))
}
async fn status(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
) -> Result<Json<Value>> {
    service.running(&state)?;
    let (mut result, translation) =
        tokio::join!(service.speech.status(), service.translation.status());
    result["translation"] = translation;
    Ok(Json(result))
}
async fn prepare(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>> {
    service.running(&state)?;
    let voice = input["voice"].as_str().unwrap_or("");
    let value = payload::validate(
        &json!({"voice": voice, "text": "準備"}),
        &service.speech.settings,
    )?;
    let needs_translation = input["translation"] == true;
    let started = Instant::now();
    let translation = async {
        if needs_translation {
            service.translation.prepare().await?;
        }
        Ok::<_, ApiError>(())
    };
    tokio::try_join!(service.speech.prepare(&value), translation)?;
    Ok(Json(
        json!({"ok": true, "voice": voice, "translation": needs_translation, "prepareMs": started.elapsed().as_millis()}),
    ))
}
async fn post_audio(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    Json(input): Json<Value>,
) -> Result<Response> {
    service.running(&state)?;
    let value = payload::validate(&input, &service.speech.settings)?;
    let mut response = service.speech.stream(value).await?;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}
async fn get_audio(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<VoiceService>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response> {
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
    let value = payload::validate(&input, &service.speech.settings)?;
    let (bytes, cached) = service.speech.buffered(value).await?;
    Ok((
        [
            ("content-type", "audio/wav"),
            ("cache-control", "no-store"),
            ("x-accel-buffering", "no"),
            ("x-tts-cache", if cached { "hit" } else { "miss" }),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests;
