use super::*;
use axum::response::IntoResponse;

impl Speech {
    pub(super) fn native_status(&self) -> Value {
        let configured = |id: &str| {
            self.settings.profiles.get(id).is_some_and(|profile| {
                profile.configured()
                    && [
                        &profile.gpt_weights_path,
                        &profile.sovits_weights_path,
                        &profile.reference.ref_audio_path,
                    ]
                    .iter()
                    .all(|path| !path.is_empty() && std::path::Path::new(path).is_file())
            })
        };
        let ready = self.native.ready();
        json!({"online":ready,"available":self.native.files_present(),"engine":self.settings.engine.label(),
            "streamingPcm":false,"voices":{"nene":configured("nene"),"natsume":configured("natsume")},
            "activeVoice":if ready { self.active.lock().unwrap().voice.clone() } else { String::new() },"queue":self.queue.status()})
    }

    pub async fn audio(self: &Arc<Self>, value: Validated, deadline: Deadline) -> Result<Response> {
        if self.settings.engine != Engine::GptSoVitsNative {
            return self.stream(value, deadline).await;
        }
        let (bytes, cached) = self.buffered(value, deadline).await?;
        Ok((
            [
                ("content-type", "audio/wav"),
                ("x-tts-cache", if cached { "hit" } else { "miss" }),
            ],
            bytes,
        )
            .into_response())
    }
}
