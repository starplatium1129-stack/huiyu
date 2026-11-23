use super::*;
use axum::response::IntoResponse;

impl Speech {
    pub(super) fn native_status(&self, settings: &Settings) -> Value {
        let voices: serde_json::Map<String, Value> = settings
            .voice_ids()
            .into_iter()
            .map(|id| {
                let ok = settings
                    .profiles
                    .get(&id)
                    .is_some_and(|profile| profile.native_files_present());
                (id, Value::Bool(ok))
            })
            .collect();
        let ready = self.native.ready();
        json!({"online":ready,"available":self.native.files_present(),"engine":settings.engine.label(),
            "engineId":settings.engine.id(),"needsTranslation":true,
            "streamingPcm":false,"voices":voices,"voiceLabels":settings.voice_labels(),"voiceCatalogMap":settings.voice_catalog_map(),
            "activeVoice":if ready { self.active.lock().unwrap().voice.clone() } else { String::new() },"queue":self.queue.status()})
    }

    pub async fn audio(self: &Arc<Self>, value: Validated, deadline: Deadline) -> Result<Response> {
        let settings = self.current_settings();
        if !matches!(settings.engine, Engine::GptSoVitsNative | Engine::OpenAiTts) {
            return self.stream(value, deadline).await;
        }
        let (bytes, content_type, cached) = self.buffered(value, deadline).await?;
        let mut response = (
            [("x-tts-cache", if cached { "hit" } else { "miss" })],
            bytes,
        )
            .into_response();
        if let Ok(value) = axum::http::HeaderValue::from_str(&content_type) {
            response.headers_mut().insert("content-type", value);
        }
        Ok(response)
    }
}
