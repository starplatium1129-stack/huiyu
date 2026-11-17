mod client;
mod server;

const COMPLETION_HEADER: &str = "x-huiyu-image-completion";
const COMPLETION_WAIT: std::time::Duration = std::time::Duration::from_secs(15);

pub(crate) enum Completion {
    Signalled,
    Receipt(serde_json::Value),
}

pub(super) use client::Client;
pub(crate) use server::{listening, start};
