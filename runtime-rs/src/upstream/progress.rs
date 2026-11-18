use super::client::{CONNECT_TIMEOUT, local_url};
use crate::error::Result;
use futures_util::StreamExt;
use serde_json::Value;
use std::{borrow::Cow, collections::HashMap, fmt::Write, sync::Arc, time::Duration};
use tokio::{
    sync::{broadcast, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default)]
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
    active: watch::Sender<HashMap<String, String>>,
    events: broadcast::Sender<Arc<ProgressUpdate>>,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl ProgressMonitor {
    pub fn new(host: &str, client_id: &str) -> Result<Self> {
        let mut url = local_url(host)?;
        url.set_scheme("ws").expect("HTTP URL supports WS scheme");
        url.set_path("/ws");
        url.query_pairs_mut().append_pair("clientId", client_id);
        let (active, receiver) = watch::channel(HashMap::new());
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

    pub fn watch(&self, prompt_id: &str, job_id: &str) {
        self.active.send_modify(|jobs| {
            jobs.insert(prompt_id.to_owned(), job_id.to_owned());
        });
    }
    pub fn unwatch(&self, prompt_id: &str) {
        self.active
            .send_if_modified(|jobs| jobs.remove(prompt_id).is_some());
    }
    pub fn watched_jobs(&self, prompt_id: Option<&str>) -> Vec<String> {
        let jobs = self.active.borrow();
        match prompt_id {
            Some(id) => jobs.get(id).cloned().into_iter().collect(),
            None => jobs.values().cloned().collect(),
        }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<ProgressUpdate>> {
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
    mut active: watch::Receiver<HashMap<String, String>>,
    events: broadcast::Sender<Arc<ProgressUpdate>>,
    cancel: CancellationToken,
) {
    let mut states: HashMap<String, Arc<ProgressUpdate>> = HashMap::new();
    loop {
        if active.borrow_and_update().is_empty() {
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
                        states.retain(|id, _| current.contains_key(id));
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
        // A reconnected socket has no reliable previous node or progress sample.
        states.clear();
        if active.borrow().is_empty() {
            continue;
        }
        let _ = events.send(Arc::new(ProgressUpdate {
            event: "connection_lost".into(),
            ..Default::default()
        }));
        tokio::select! {
            _ = cancel.cancelled() => return,
            changed = active.changed() => if changed.is_err() { return; },
            _ = tokio::time::sleep(Duration::from_secs(2)) => {},
        }
    }
}

fn text(value: &Value) -> Option<Cow<'_, str>> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(Cow::Borrowed(value)),
        _ => Some(Cow::Owned(crate::storage::stringify(value))),
    }
}

fn apply(
    raw: &str,
    active: &HashMap<String, String>,
    states: &mut HashMap<String, Arc<ProgressUpdate>>,
) -> Option<Arc<ProgressUpdate>> {
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
    if !active.contains_key(prompt_id.as_ref()) {
        return None;
    }
    let snapshot = states
        .entry(prompt_id.as_ref().to_owned())
        .or_insert_with(|| {
            Arc::new(ProgressUpdate {
                prompt_id: prompt_id.into_owned(),
                ..Default::default()
            })
        });
    let state = Arc::make_mut(snapshot);
    event.clone_into(&mut state.event);
    state.progress_text.clear();
    match event {
        "execution_start" => {
            state.progress = None;
            state.current_node = None;
            state.progress_text.push_str("ComfyUI 开始执行…");
        }
        "progress" => {
            state.progress = data["value"]
                .as_f64()
                .zip(data["max"].as_f64())
                .filter(|(_, max)| *max > 0.0)
                .map(|(value, max)| (value / max).clamp(0.0, 1.0));
            if let Some(node) = text(&data["node"]) {
                state.current_node = Some(node.into_owned());
            }
            if state.progress.is_none() {
                state.progress_text.push_str("ComfyUI 正在推理…");
            } else {
                write!(
                    &mut state.progress_text,
                    "采样 {} / {}",
                    data["value"], data["max"]
                )
                .unwrap();
                if let Some(node) = &state.current_node {
                    write!(&mut state.progress_text, " · 节点 {node}").unwrap();
                }
            }
        }
        "executing" => {
            let next_node = text(&data["node"]).map(Cow::into_owned);
            // A sampler reaching 100% does not make the following VAE decode
            // measurable. Each new node waits for its own actual step events.
            if next_node != state.current_node {
                state.progress = None;
            }
            state.current_node = next_node;
            match &state.current_node {
                Some(node) => write!(&mut state.progress_text, "执行节点 {node}").unwrap(),
                None => {
                    state.progress = Some(1.0);
                    state.progress_text.push_str("ComfyUI 正在收尾…");
                }
            }
        }
        "execution_cached" => state.progress_text.push_str("ComfyUI 使用缓存节点…"),
        "execution_success" => state.progress_text.push_str("ComfyUI 正在确认生成结果…"),
        "execution_error" | "execution_interrupted" => {
            state.progress_text.push_str("ComfyUI 正在核对执行状态…");
        }
        _ => unreachable!(),
    }
    Some(snapshot.clone())
}
