mod ai;
mod batch;
mod batch_input;
mod catalog;
mod download;
mod http;
mod inputs;
mod prose;
mod resources;
mod resume;
mod service;
mod storyboard;
mod transcode;
mod validation;
mod workflow;

use crate::{
    error::{ApiError, Result},
    generation::{self, ExecutionHooks, Observation, Output},
    upstream::LocalUpstream,
};
pub use batch::BatchPrepared;
pub use generation::Config;
use serde_json::{Value, json};
pub use service::{Prepared, Service};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
pub use transcode::Transcoder;
pub type VideoService = Service;
pub fn auxiliary_router() -> axum::Router<crate::AppState> {
    ai::router().merge(storyboard::router())
}
pub fn router(service: Arc<Service>) -> axum::Router<crate::AppState> {
    http::router(service)
}
pub use batch_input::validate_batch;
pub use catalog::catalog;
pub(crate) use download::materialize;
pub use validation::{fit_canvas, validate};
pub use workflow::build as build_workflow;
fn error(status: u16, code: &str, message: impl Into<String>) -> ApiError {
    ApiError::new(status, code, message)
}
