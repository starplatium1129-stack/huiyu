mod admission;
pub mod bootstrap;
pub mod catalog;
pub mod character_art;
pub mod chat;
mod collation;
pub mod config;
pub mod control;
pub mod desktop_tools;
pub mod error;
pub mod execution;
pub(crate) mod file_identity;
mod file_paths;
pub mod generation;
pub mod host;
pub mod images;
pub mod interrogate;
pub mod live2d;
pub mod maintenance;
pub mod native_images;
pub(crate) mod processes;
pub mod reference;
pub mod remote_content;
pub mod resources;
pub mod security;
pub mod static_files;
pub mod storage;
pub mod task_contract;
pub mod task_runtime;
pub mod tasks_http;
pub mod upstream;
pub mod video;
pub mod voice;
pub mod workspace_http;

use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::HeaderMap,
    routing::get,
};
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;
use std::{net::SocketAddr, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub(crate) catalog_projections: Arc<catalog::ProjectionCache>,
    pub host: Arc<host::HostAuthority>,
    pub shutdown: CancellationToken,
    pub chat: Option<Arc<chat::ChatService>>,
    pub voice: Option<Arc<voice::VoiceService>>,
    pub generation: Option<Arc<generation::GenerationService>>,
    pub tasks: Option<Arc<task_runtime::TaskRuntime>>,
    pub live2d: Option<Arc<live2d::Live2dService>>,
    pub desktop_tools: Option<Arc<desktop_tools::DesktopToolsService>>,
    pub images: Option<Arc<images::ImageService>>,
    pub video: Option<Arc<video::VideoService>>,
    pub maintenance: Option<Arc<maintenance::MaintenanceService>>,
    pub interrogate: Option<Arc<interrogate::InterrogateService>>,
    pub remote: Option<Arc<remote_content::RemoteAccess>>,
    pub resources: Option<Arc<resources::Service>>,
    pub control: Option<Arc<control::ControlService>>,
}
impl AppState {
    pub fn new(
        config: Arc<config::Config>,
        host: Arc<host::HostAuthority>,
        shutdown: CancellationToken,
    ) -> Self {
        Self {
            config,
            catalog_projections: Arc::new(catalog::ProjectionCache::default()),
            host,
            shutdown,
            chat: None,
            voice: None,
            generation: None,
            tasks: None,
            live2d: None,
            desktop_tools: None,
            images: None,
            video: None,
            maintenance: None,
            interrogate: None,
            remote: None,
            resources: None,
            control: None,
        }
    }
}

pub fn router(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/api/health", get(health))
        .merge(host::router())
        .merge(workspace_http::router())
        .merge(reference::router())
        .merge(character_art::router())
        .merge(catalog::router())
        .merge(upstream::router(&state.config))
        .merge(tasks_http::router());
    if let Some(service) = &state.chat {
        router = router.merge(chat::router(service.clone()));
    }
    if let Some(service) = &state.voice {
        router = router.merge(voice::router(service.clone()));
    }
    if let Some(service) = &state.generation {
        router = router.merge(generation::router(service.clone()));
    }
    if let Some(service) = &state.live2d {
        router = router.merge(live2d::router(service.clone()));
    }
    if let Some(service) = &state.desktop_tools {
        router = router.merge(desktop_tools::router(service.clone()));
    }
    if let Some(service) = &state.images {
        router = router.merge(images::router(service.clone()));
    }
    if let Some(service) = &state.video {
        router = router.merge(video::router(service.clone()));
    }
    router = router.merge(video::auxiliary_router());
    if let Some(service) = &state.interrogate {
        router = router.merge(interrogate::router(service.clone()));
    }
    if let Some(service) = &state.resources {
        router = router.merge(resources::router(service.clone()));
    }
    if let Some(service) = &state.control {
        router = router.merge(control::router(service.clone()));
    }
    if let Some(service) = &state.maintenance {
        router = router.merge(maintenance::router(service.clone()));
    }
    router = router.fallback(static_files::serve);
    if let Some(service) = &state.resources {
        router = router.layer(axum::middleware::from_fn_with_state(
            service.clone(),
            resources::overlay,
        ));
    }
    if let Some(service) = &state.maintenance {
        router = router.layer(axum::middleware::from_fn_with_state(
            service.clone(),
            maintenance::read_barrier,
        ));
    }
    router
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            admission::track,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            security::guard,
        ))
        .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(
            std::time::Duration::from_secs(30),
        ))
        .with_state(state)
}

async fn health(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    let live2d_health = state
        .live2d
        .as_ref()
        .map(|service| service.health_status())
        .unwrap_or(json!({"available":false,"checkedAt":null,"stale":false,"refreshing":false}));
    let live2d = live2d_health["available"] == true;
    let mut result = json!({"ok":true,"app":"ai-cg-studio","gateway":true,"desktopProtocol":1,
        "port":state.config.bind.port(),"capabilities":{"chat":state.chat.is_some(),"tts":state.voice.is_some(),"translation":state.voice.is_some(),"live2d":live2d},
        "queues":{"chat":state.chat.as_ref().map(|service|service.queue_status()).unwrap_or(json!({"running":false,"pending":0})),
          "voice":state.voice.as_ref().map(|service|service.queue_status()).unwrap_or(json!({"running":false,"pending":0})),
          "resources":state.resources.as_ref().map(|service|service.queue_status()).unwrap_or(json!({"active":0,"queued":0,"max":1}))},
        "capabilityStatus":{"live2d":live2d_health},
        "runtime":"rust","migrationCandidate":true});
    if security::is_direct_local(&headers, peer.ip())
        && let (Some(secret), Some(challenge)) = (
            &state.config.desktop_secret,
            headers
                .get("x-aics-desktop-challenge")
                .and_then(|h| h.to_str().ok()),
        )
        && challenge.len() == 64
        && challenge
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .expect("HMAC accepts arbitrary key lengths");
        mac.update(challenge.as_bytes());
        result["desktopProof"] = hex::encode(mac.finalize().into_bytes()).into();
    }
    Json(result)
}
