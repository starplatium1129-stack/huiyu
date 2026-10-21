mod client;
mod health;
pub(crate) use health::HealthProbes;
pub mod progress;
mod proxy;

use crate::AppState;
use axum::{Extension, Router, http::HeaderValue, routing::any};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::Arc;

pub(crate) use client::diagnostic_message;
pub use client::{LocalUpstream, local_url};

pub(crate) const READ_PATHS: &[&str] = &[
    "/sdapi/v1/sd-models",
    "/sdapi/v1/samplers",
    "/sdapi/v1/schedulers",
    "/sdapi/v1/options",
];
const BLOCKED: &[&str] = &[
    "sdapi",
    "controlnet",
    "adetailer",
    "comfy",
    "prompt",
    "queue",
    "history",
    "object_info",
    "interrupt",
    "view",
];

struct Proxy {
    transport: LocalUpstream,
    sd_host: String,
    sd_auth: Option<HeaderValue>,
}

pub fn router(config: &crate::config::Config) -> Router<AppState> {
    router_with(Proxy {
        transport: LocalUpstream::new(),
        sd_host: config.sd_host.clone(),
        sd_auth: config.sd_auth.as_ref().map(|auth| {
            HeaderValue::try_from(format!("Basic {}", STANDARD.encode(auth)))
                .expect("Base64 authorization contains only valid header bytes")
        }),
    })
}

fn router_with(proxy: Proxy) -> Router<AppState> {
    let mut router = Router::new();
    for path in READ_PATHS {
        router = router.route(path, any(proxy::forward));
    }
    for prefix in BLOCKED {
        router = router
            .route(&format!("/{prefix}"), any(proxy::unavailable))
            .route(&format!("/{prefix}/{{*path}}"), any(proxy::unavailable));
    }
    router.layer(Extension(Arc::new(proxy)))
}
