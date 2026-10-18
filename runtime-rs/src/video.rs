mod ai;
mod batch;
mod batch_input;
mod catalog;
mod http;
mod inputs;
mod native;
mod prose;
mod resources;
mod requests;
mod resume;
mod service;
mod storyboard;
mod transcode;
mod validation;
mod workflow;

use crate::{
    error::{ApiError, Result},
    execution::{ExecutionHooks, Observation, Output},
    generation,
    upstream::LocalUpstream,
};
pub use batch::BatchPrepared;
pub(crate) use batch::BatchRecovery;
pub use generation::Config;
use serde_json::{Value, json};
pub(crate) use service::MediaImport;
pub use service::{Prepared, Service};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
pub type VideoService = Service;
pub fn auxiliary_router() -> axum::Router<crate::AppState> {
    ai::router().merge(storyboard::router())
}
pub fn router(service: Arc<Service>) -> axum::Router<crate::AppState> {
    http::router(service)
}
fn error(status: u16, code: &str, message: impl Into<String>) -> ApiError {
    ApiError::new(status, code, message)
}
