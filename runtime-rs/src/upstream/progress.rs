use super::client::{CONNECT_TIMEOUT, local_url};
use crate::error::Result;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use tokio::{
    sync::{broadcast, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUpdate {
    pub prompt_id: String,
    pub progress: Option<f64>,
    pub current_node: Option<String>,
    pub progress_text: String,
    pub event: String,
}
impl ProgressUpdate {
    pub fn terminal_hint(&self) -> bool {
        matches!(
            self.event.as_str(),
            "execution_success" | "execution_error" | "execution_interrupted"
        ) || self.event == "executing" && self.current_node.is_none()
    }
}

/// Best-effort progress only. History polling remains authoritative for terminal
/// state; providers must unwatch finished/cancelled jobs and ignore late updates.
pub struct ProgressMonitor {
    active: watch::Sender<HashSet<String>>,
    events: broadcast::Sender<ProgressUpdate>,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl ProgressMonitor {
    pub fn new(host: &str, client_id: &str) -> Result<Self> {
        let mut url = local_url(host)?;
        url.set_scheme("ws").expect("HTTP URL supports WS scheme");
        url.set_path("/ws");
        url.query_pairs_mut().append_pair("clientId", client_id);
        let (active, receiver) = watch::channel(HashSet::new());
        let (events, _) = broadcast::channel(32);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run(
            url.to_string(),
            receiver,
            events.clone(),
            cancel.clone(),
        ));
        Ok(Self {
            active,
            events,
            cancel,
            task,
        })
    }

    pub fn watch(&self, prompt_id: impl Into<String>) {
        self.active.send_modify(|set| {
            set.insert(prompt_id.into());
        });
    }
    pub fn unwatch(&self, prompt_id: &str) {
        self.active.send_modify(|set| {
            set.remove(prompt_id);
        });
    }
    pub fn subscribe(&self) -> broadcast::Receiver<ProgressUpdate> {
        self.events.subscribe()
    }
    pub async fn close(mut self) {
        self.cancel.cancel();
        let _ = (&mut self.task).await;
    }
}

impl Drop for ProgressMonitor {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn run(
    url: String,
    mut active: watch::Receiver<HashSet<String>>,
    events: broadcast::Sender<ProgressUpdate>,
    cancel: CancellationToken,
) {
    let mut states: HashMap<String, ProgressUpdate> = HashMap::new();
    loop {
        if active.borrow().is_empty() {
            states.clear();
            tokio::select! { _ = cancel.cancelled() => return, result = active.changed() => if result.is_err() { return; } }
            continue;
        }
        let connection = tokio::select! {
            _ = cancel.cancelled() => return,
            changed = active.changed() => { if changed.is_err() { return; } continue; },
            result = tokio::time::timeout(CONNECT_TIMEOUT, connect_async(&url)) => result,
        };
        if let Ok(Ok((mut socket, _))) = connection {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    changed = active.changed() => {
                        if changed.is_err() { return; }
                        let current = active.borrow_and_update();
                        states.retain(|id, _| current.contains(id));
                        if current.is_empty() { break; }
                    },
                    message = socket.next() => match message {
                        Some(Ok(Message::Text(raw))) => {
                            if let Some(update) = apply(&raw, &active.borrow(), &mut states) { let _ = events.send(update); }
                        },
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        // Binary previews are never converted into strings or parsed.
                        _ => {},
                    }
                }
            }
        }
        if active.borrow().is_empty() {
            continue;
        }
        let _ = events.send(ProgressUpdate {
            event: "connection_lost".into(),
            ..Default::default()
        });
        tokio::select! {
            _ = cancel.cancelled() => return,
            changed = active.changed() => if changed.is_err() { return; },
            _ = tokio::time::sleep(Duration::from_secs(2)) => {},
        }
    }
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        _ => Some(crate::storage::stringify(value)),
    }
}

fn apply(
    raw: &str,
    active: &HashSet<String>,
    states: &mut HashMap<String, ProgressUpdate>,
) -> Option<ProgressUpdate> {
    let message: Value = serde_json::from_str(raw).ok()?;
    let event = message["type"].as_str()?;
    if ![
        "execution_start",
        "progress",
        "executing",
        "execution_cached",
        "execution_success",
        "execution_error",
        "execution_interrupted",
    ]
    .contains(&event)
    {
        return None;
    }
    let data = &message["data"];
    let prompt_id = text(data.get("prompt_id").unwrap_or(&message["prompt_id"]))?;
    if !active.contains(&prompt_id) {
        return None;
    }
    let state = states
        .entry(prompt_id.clone())
        .or_insert_with(|| ProgressUpdate {
            prompt_id,
            ..Default::default()
        });
    state.event = event.into();
    match event {
        "execution_start" => {
            state.progress = None;
            state.current_node = None;
            state.progress_text = "ComfyUI 开始执行…".into();
        }
        "progress" => {
            state.progress = data["value"]
                .as_f64()
                .zip(data["max"].as_f64())
                .filter(|(_, max)| *max > 0.0)
                .map(|(value, max)| (value / max).clamp(0.0, 1.0));
            if let Some(node) = text(&data["node"]) {
                state.current_node = Some(node);
            }
            state.progress_text = if state.progress.is_none() {
                "ComfyUI 正在推理…".into()
            } else {
                format!(
                    "采样 {} / {}{}",
                    data["value"],
                    data["max"],
                    state
                        .current_node
                        .as_ref()
                        .map(|node| format!(" · 节点 {node}"))
                        .unwrap_or_default()
                )
            };
        }
        "executing" => {
            state.current_node = text(&data["node"]);
            state.progress_text = match &state.current_node {
                Some(node) => format!("执行节点 {node}"),
                None => {
                    state.progress = Some(1.0);
                    "ComfyUI 正在收尾…".into()
                }
            };
        }
        "execution_cached" => state.progress_text = "ComfyUI 使用缓存节点…".into(),
        "execution_success" => state.progress_text = "ComfyUI 正在确认生成结果…".into(),
        "execution_error" | "execution_interrupted" => {
            state.progress_text = "ComfyUI 正在核对执行状态…".into();
        }
        _ => unreachable!(),
    }
    Some(state.clone())
}

#[cfg(test)]
mod tests;
