mod client;
pub mod progress;
mod proxy;

use crate::AppState;
use axum::{Extension, Router, routing::any};
use std::sync::Arc;

pub(crate) use client::diagnostic_message;
pub use client::{LocalUpstream, local_url};

pub(crate) const READ_PATHS: &[&str] = &[
    "/sdapi/v1/sd-models",
    "/sdapi/v1/samplers",
    "/sdapi/v1/schedulers",
    "/sdapi/v1/upscalers",
    "/sdapi/v1/options",
    "/sdapi/v1/progress",
];
const WRITE_PATHS: &[&str] = &[
    "/sdapi/v1/txt2img",
    "/sdapi/v1/options",
    "/sdapi/v1/interrupt",
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
    sd_auth: Option<String>,
}

pub fn router(config: &crate::config::Config) -> Router<AppState> {
    router_with(Proxy {
        transport: LocalUpstream::new(),
        sd_host: config.sd_host.clone(),
        sd_auth: config.sd_auth.clone(),
    })
}

fn router_with(proxy: Proxy) -> Router<AppState> {
    let mut router = Router::new();
    let mut paths = std::collections::HashSet::new();
    for path in READ_PATHS.iter().chain(WRITE_PATHS.iter()) {
        if paths.insert(*path) {
            router = router.route(path, any(proxy::forward));
        }
    }
    for prefix in BLOCKED {
        router = router
            .route(&format!("/{prefix}"), any(proxy::unavailable))
            .route(&format!("/{prefix}/{{*path}}"), any(proxy::unavailable));
    }
    router.layer(Extension(Arc::new(proxy)))
}

#[cfg(test)]
mod tests;
