mod collect;
mod local;
mod providers;
mod streaming;
mod wave;
pub(crate) use wave::{is_pcm_wave, pcm_video_frames};

use super::{
    config::{Engine, Settings},
    payload::Validated,
    queue::{Queue, Reservation, cancelled, remaining, speech_timeout},
    translation::Translation,
};
use crate::{
    error::{ApiError, Result},
    upstream::{HealthProbes, LocalUpstream},
};
use axum::{body::Bytes, response::Response};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::{BufWriter, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use tokio::time::Instant as Deadline;
use tokio_util::sync::CancellationToken;

type SharedResult = std::result::Result<(Bytes, String), (u16, String, String)>;
// Only request-owned receivers count as consumers. The cache retains a sender,
// so an abandoned whole-clip request can release its queue slot.
type Flight = Arc<watch::Sender<Option<SharedResult>>>;
struct Subscriber {
    receiver: Option<watch::Receiver<Option<SharedResult>>>,
    flight: Flight,
    cache: Arc<Mutex<AudioCache>>,
    key: String,
}
impl Drop for Subscriber {
    fn drop(&mut self) {
        // Serialize the last receiver's drop with new subscriptions. Otherwise
        // a caller could join between closed() firing and flight removal.
        let mut cache = self.cache.lock().unwrap();
        drop(self.receiver.take());
        if self.flight.is_closed()
            && cache
                .flights
                .get(&self.key)
                .is_some_and(|current| Arc::ptr_eq(current, &self.flight))
        {
            cache.flights.remove(&self.key);
        }
    }
}
const AUDIO_LIMIT: usize = 128 * 1024 * 1024;
#[derive(Default)]
struct Active {
    gpt: String,
    sovits: String,
    voice: String,
    lora: String,
}
#[derive(Default)]
struct AudioCache {
    entries: VecDeque<(String, CachedAudio)>,
    bytes: usize,
    flights: HashMap<String, Flight>,
}
#[derive(Clone)]
struct CachedAudio {
    bytes: Bytes,
    content_type: String,
    pcm: Option<std::ops::Range<usize>>,
}
pub(super) struct Speech {
    settings: std::sync::RwLock<Arc<Settings>>,
    pub queue: Queue,
    transport: LocalUpstream,
    http_client: reqwest::Client,
    cancel: CancellationToken,
    active: Mutex<Active>,
    cache: Arc<Mutex<AudioCache>>,
    probes: Arc<HealthProbes>,
    pub(super) native: Arc<super::native::Native>,
}
impl Speech {
    pub fn new(
        settings: Arc<Settings>,
        transport: LocalUpstream,
        cancel: CancellationToken,
        probes: Arc<HealthProbes>,
        translation: Arc<Translation>,
    ) -> Arc<Self> {
        let queue = Queue::new(settings.engine.id());
        let native = super::native::Native::new(&settings, cancel.child_token(), translation);
        let http_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Arc::new(Self {
            settings: std::sync::RwLock::new(settings),
            transport,
            http_client,
            cancel,
            queue,
            active: Mutex::new(Active::default()),
            cache: Arc::new(Mutex::new(AudioCache::default())),
            probes,
            native,
        })
    }
    pub fn current_settings(&self) -> Arc<Settings> {
        self.settings.read().unwrap().clone()
    }
    pub fn update_settings(&self, next: Arc<Settings>) {
        self.native.update_paths(&next);
        *self.settings.write().unwrap() = next;
        self.close();
        *self.active.lock().unwrap() = Active::default();
    }
    pub async fn status(&self) -> Value {
        self.status_observed(true).await
    }
    pub async fn status_observed(&self, fresh: bool) -> Value {
        let settings = self.current_settings();
        let voice_ids = settings.voice_ids();
        let voice_labels = settings.voice_labels();
        let voice_catalog_map = settings.voice_catalog_map();
        let voices_map = |enabled_for: &dyn Fn(&str) -> bool| -> serde_json::Map<String, Value> {
            voice_ids
                .iter()
                .map(|id| (id.clone(), Value::Bool(enabled_for(id))))
                .collect()
        };
        match settings.engine {
            Engine::Off => {
                return json!({
                    "online": false,
                    "engine": settings.engine.label(),
                    "engineId": settings.engine.id(),
                    "needsTranslation": false,
                    "streamingPcm": false,
                    "voices": voices_map(&|_| false),
                    "voiceLabels": voice_labels,
                    "voiceCatalogMap": voice_catalog_map,
                    "activeVoice": "",
                    "queue": self.queue.status()
                });
            }
            Engine::System => {
                return json!({
                    "online": true,
                    "engine": settings.engine.label(),
                    "engineId": settings.engine.id(),
                    "needsTranslation": false,
                    "clientSide": true,
                    "streamingPcm": false,
                    "voices": voices_map(&|_| true),
                    "voiceLabels": voice_labels,
                    "voiceCatalogMap": voice_catalog_map,
                    "activeVoice": "",
                    "queue": self.queue.status()
                });
            }
            Engine::OpenAiTts => {
                let configured = settings.openai.configured();
                return json!({
                    "online": configured,
                    "engine": settings.engine.label(),
                    "engineId": settings.engine.id(),
                    "needsTranslation": false,
                    "streamingPcm": false,
                    "voices": voices_map(&|_| configured),
                    "voiceLabels": voice_labels,
                    "voiceCatalogMap": voice_catalog_map,
                    "activeVoice": if configured { "openai-tts" } else { "" },
                    "queue": self.queue.status()
                });
            }
            Engine::GptSoVitsNative => return self.native_status(&settings),
            Engine::GptSoVits | Engine::VoxCpm2 => {}
        }
        let vox = settings.engine == Engine::VoxCpm2;
        let wait = Duration::from_millis(1500);
        let health = self.probes.read(
            &settings.tts_host,
            "/health",
            wait,
            if vox { 1024 * 1024 } else { 64 * 1024 },
            fresh,
        );
        let online = if vox {
            health.await.is_some_and(|probe| {
                (200..300).contains(&probe.status)
                    && probe
                        .json
                        .as_ref()
                        .is_some_and(|v| v["online"] == true && v["engine"] == "VoxCPM2")
            })
        } else {
            // The docs response confirms the API, while health distinguishes Vox.
            let docs = self
                .probes
                .read(&settings.tts_host, "/docs", wait, 1024 * 1024, fresh);
            let (docs, health) = tokio::join!(docs, health);
            docs.is_some_and(|probe| (200..500).contains(&probe.status))
                && !health.is_some_and(|probe| {
                    probe
                        .json
                        .as_ref()
                        .is_some_and(|v| v["engine"] == "VoxCPM2")
                })
        };
        let voice = self.active.lock().unwrap().voice.clone();
        let configured = |id: &str| {
            settings.profiles.get(id).is_some_and(|p| {
                p.configured()
                    && (settings.engine != Engine::VoxCpm2 || !p.lora_weights_path.is_empty())
            })
        };
        json!({"online": online, "engine": settings.engine.label(), "engineId": settings.engine.id(), "needsTranslation": settings.needs_translation(), "streamingPcm": settings.engine == Engine::VoxCpm2,
            "voices": voices_map(&configured), "voiceLabels": voice_labels, "voiceCatalogMap": voice_catalog_map, "activeVoice": voice, "queue": self.queue.status()})
    }
    pub async fn stream(&self, value: Validated, deadline: Deadline) -> Result<Response> {
        let settings = self.current_settings();
        let key = self.cache_key(&settings, &value);
        if let Some(response) = self.cached_response(&key, false) {
            return Ok(response);
        }
        self.stream_inner(value, key, false, deadline).await
    }
    pub async fn buffered(
        self: &Arc<Self>,
        value: Validated,
        deadline: Deadline,
    ) -> Result<(Bytes, String, bool)> {
        let settings = self.current_settings();
        let key = self.cache_key(&settings, &value);
        let (mut subscriber, hit) = {
            let mut cache = self.cache.lock().unwrap();
            if let Some((_, audio)) = cache.entries.iter().find(|(cached, _)| *cached == key) {
                return Ok((audio.bytes.clone(), audio.content_type.clone(), true));
            }
            let (receiver, flight, hit) = if let Some(flight) = cache.flights.get(&key) {
                (flight.subscribe(), flight.clone(), true)
            } else {
                let reservation = self.queue.reserve()?;
                let (send, receiver) = watch::channel(None);
                let send = Arc::new(send);
                cache.flights.insert(key.clone(), send.clone());
                let speech = self.clone();
                let task_key = key.clone();
                let task_send = send.clone();
                // Cancel only after every real caller leaves. One caller's
                // cancellation must not stop a shared synthesis or its cache.
                tokio::spawn(async move {
                    // Shared work gets one budget from its real entry. A later
                    // listener cannot extend it or cancel another listener's work.
                    let deadline = Deadline::now() + Duration::from_secs(240);
                    let result = tokio::select! {
                        biased;
                        _ = task_send.closed() => None,
                        result = speech.collect(value, reservation, &task_key, deadline) => Some(result),
                    };
                    if let Some(result) = result {
                        let result = result
                            .map_err(|error| (error.status.as_u16(), error.code, error.message));
                        let _ = task_send.send(Some(result));
                    }
                    let mut cache = speech.cache.lock().unwrap();
                    // A new caller may already have replaced an abandoned
                    // same-key flight; an older worker cannot remove that one.
                    if cache
                        .flights
                        .get(&task_key)
                        .is_some_and(|current| Arc::ptr_eq(current, &task_send))
                    {
                        cache.flights.remove(&task_key);
                    }
                });
                (receiver, send, false)
            };
            (
                Subscriber {
                    receiver: Some(receiver),
                    flight,
                    cache: self.cache.clone(),
                    key,
                },
                hit,
            )
        };
        loop {
            remaining(deadline, Duration::MAX, speech_timeout)?;
            let receiver = subscriber.receiver.as_mut().unwrap();
            let result = receiver.borrow().clone();
            if let Some(result) = result {
                return result
                    .map(|(bytes, content_type)| (bytes, content_type, hit))
                    .map_err(|(status, code, message)| ApiError::new(status, code, message));
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(cancelled()),
                _ = tokio::time::sleep_until(deadline) => return Err(speech_timeout()),
                result = receiver.changed() => result.map_err(|_| cancelled())?,
            }
        }
    }
    fn cache_key(&self, settings: &Settings, value: &Validated) -> String {
        let mut hash = BufWriter::with_capacity(8 * 1024, Sha256::new());
        // A tuple preserves the existing JSON array encoding while borrowing
        // the validated payload instead of copying its tree and encoded bytes.
        serde_json::to_writer(
            &mut hash,
            &(
                settings.engine.id(),
                &settings.openai.base_url,
                &settings.openai.model,
                &settings.tts_host,
                &value.voice,
                &value.profile.gpt_weights_path,
                &value.profile.sovits_weights_path,
                &value.payload,
            ),
        )
        .unwrap();
        hash.flush().expect("Hash writer is infallible");
        hex::encode(hash.into_inner().unwrap().finalize())
    }
    fn cached_audio(&self, key: &str) -> Option<CachedAudio> {
        self.cache
            .lock()
            .unwrap()
            .entries
            .iter()
            .find(|(id, _)| id == key)
            .map(|(_, audio)| audio.clone())
    }
    pub fn close(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.entries.clear();
        cache.flights.clear();
        cache.bytes = 0;
    }
}
