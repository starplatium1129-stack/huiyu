mod client;
mod guide;
mod muse;
mod relay;
mod server;
mod upload_index;

pub(in crate::images) use upload_index::UploadIndex;

const COMPLETION_HEADER: &str = "x-huiyu-image-completion";
const COMPLETION_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) enum Completion {
    Signalled,
    Receipt(serde_json::Value),
}

pub(super) use client::Client;
pub(super) use guide::Guide;
pub(crate) use server::{listening, start};
