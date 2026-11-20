//! Desktop turns are pulled by Muse over an already authenticated listener.
//! Each listener owns its inbox, so a second connection cannot see its turns.
use super::{
    stream::{self, Event},
    validation::Input,
    *,
};
use futures_util::{StreamExt, stream as futures_stream};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{Mutex, Weak},
    time::Instant,
};
use tokio::sync::{Semaphore, oneshot, watch};
use tokio_util::sync::{CancellationToken, DropGuard};
use uuid::Uuid;

const REPLY_WINDOW: Duration = Duration::from_secs(150);
const RECENT_POLL: Duration = Duration::from_secs(90);
const MAX_PENDING: usize = 8;
pub(crate) const MAX_INBOX_WAIT_SECONDS: u8 = 30;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InboxQuery {
    wait: Option<u32>,
}

impl InboxQuery {
    pub(crate) fn duration(&self, headers: &HeaderMap) -> Duration {
        let seconds = self.wait.or_else(|| {
            headers
                .get_all("prefer")
                .iter()
                .filter_map(|v| v.to_str().ok())
                .flat_map(|v| v.split(','))
                .filter_map(|v| v.trim().split_once('='))
                .find_map(|(key, value)| {
                    key.eq_ignore_ascii_case("wait")
                        .then(|| value.parse::<u32>().ok())
                        .flatten()
                })
        });
        Duration::from_secs(
            seconds
                .unwrap_or(0)
                .min(MAX_INBOX_WAIT_SECONDS.into())
                .into(),
        )
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Transport {
    Tailscale,
    Relay,
}

impl Transport {
    fn paths(self) -> (&'static str, &'static str) {
        match self {
            Self::Tailscale => ("/desktop/pending", "/desktop/replies"),
            Self::Relay => ("/api/muse/desktop/inbox", "/api/muse/desktop/reply"),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Tailscale => "tailscale",
            Self::Relay => "relay",
        }
    }
}

#[derive(Default)]
pub(super) struct Connections(Mutex<Vec<Weak<Inbox>>>);

struct Inbox {
    transport: Transport,
    cancel: CancellationToken,
    state: Mutex<InboxState>,
    changed: watch::Sender<()>,
    poll_slots: Semaphore,
}

#[derive(Default)]
struct InboxState {
    last_poll: Option<Instant>,
    pending: Vec<Pending>,
    receipts: VecDeque<Receipt>,
}

struct Pending {
    key: Uuid,
    deadline: Instant,
    listed_at: Option<Instant>,
    question: Value,
    answer: oneshot::Sender<String>,
}

struct Receipt {
    key: Uuid,
    digest: [u8; 32],
    deadline: Instant,
}

struct Turn {
    inbox: Arc<Inbox>,
    key: Uuid,
}

impl Drop for Turn {
    fn drop(&mut self) {
        self.inbox
            .state
            .lock()
            .unwrap()
            .pending
            .retain(|p| p.key != self.key);
    }
}

impl Inbox {
    fn items(&self, record_poll: bool) -> Vec<Value> {
        let mut state = self.state.lock().unwrap();
        let now = Instant::now();
        if record_poll {
            state.last_poll = Some(now);
        }
        let mut items = Vec::new();
        for turn in &mut state.pending {
            if turn.deadline <= now || turn.answer.is_closed() {
                continue;
            }
            if record_poll && turn.listed_at.is_none() {
                turn.listed_at = Some(now);
                let queued = turn.deadline - REPLY_WINDOW;
                eprintln!(
                    "Desktop Muse stage=inbox_listed requestKey={} sinceIngressMs={}",
                    turn.key,
                    now.duration_since(queued).as_millis()
                );
            }
            items.push(turn.question.clone());
        }
        items
    }

    fn receiving(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .last_poll
            .is_some_and(|poll| poll.elapsed() < RECENT_POLL)
    }
}

impl Connections {
    fn active(&self) -> Option<Arc<Inbox>> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|inbox| !inbox.cancel.is_cancelled())
            .max_by_key(|inbox| {
                (
                    inbox.receiving(),
                    matches!(inbox.transport, Transport::Tailscale),
                )
            })
    }

    pub(super) fn submit(&self, character: String, input: Input) -> Result<Response> {
        let inbox = self
            .active()
            .ok_or_else(|| Error::new(503, "MUSE_OFFLINE", "请先开启绘遇的 Muse 连接"))?;
        if input.tool_result_origin.is_some()
            || input.messages.iter().any(|msg| {
                !matches!(msg["role"].as_str(), Some("system" | "user" | "assistant"))
                    || !msg["content"].is_string()
                    || msg.get("tool_calls").is_some()
            })
        {
            return Err(Error::invalid("Muse 桌面聊天目前支持文字消息"));
        }
        let text = input
            .messages
            .iter()
            .rev()
            .find(|msg| msg["role"] != "system")
            .filter(|msg| msg["role"] == "user")
            .and_then(|msg| msg["content"].as_str())
            .ok_or_else(|| Error::invalid("Muse 需要一条用户消息"))?;
        let key = Uuid::new_v4();
        let deadline = Instant::now() + REPLY_WINDOW;
        let question = json!({
            "requestKey":key.to_string(), "conversationId":format!("desktop/{character}/{}", input.session_id),
            "character":character, "text":text, "messages":input.messages,
            "expiresAt":crate::host::now_ms() + REPLY_WINDOW.as_millis() as u64
        });
        if question.to_string().len() > 128 * 1024 {
            return Err(Error::invalid("Muse 的本轮聊天上下文过长"));
        }
        let (answer, receive) = oneshot::channel();
        {
            let mut state = inbox.state.lock().unwrap();
            if state.pending.len() >= MAX_PENDING {
                return Err(Error::new(
                    429,
                    "MUSE_BUSY",
                    "Muse 的待答消息已满，请稍后重试",
                ));
            }
            state.pending.push(Pending {
                key,
                deadline,
                listed_at: None,
                question,
                answer,
            });
        }
        inbox.changed.send_replace(());
        let cancel = inbox.cancel.child_token();
        let turn = Turn { inbox, key };
        let token = futures_stream::once(async move {
            let _turn = turn;
            let content = tokio::time::timeout_at(deadline.into(), receive)
                .await
                .map_err(|_| {
                    Error::stream(
                        "MUSE_TIMEOUT",
                        "等待 Muse 超时，请确认 Muse 正在轮询桌面收件箱",
                    )
                })?
                .map_err(|_| Error::stream("MUSE_OFFLINE", "Muse 连接已关闭"))?;
            Ok(Event::Token { content })
        });
        let events = futures_stream::iter([Ok(Event::Meta {
            model: "Muse".into(),
            queue_wait_ms: 0,
        })])
        .chain(token)
        .chain(futures_stream::iter([Ok(Event::Done)]));
        Ok(stream::from_events(events, 0, cancel))
    }
}

pub(super) async fn status(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response> {
    local(&headers, peer)?;
    running(&app)?;
    let active = chat.muse.active();
    Ok(([(axum::http::header::CACHE_CONTROL, "no-store")], Json(json!({
        "ok":true, "available":active.is_some(), "receiving":active.as_ref().is_some_and(|i| i.receiving()),
        "transport":active.as_ref().map(|i| i.transport.name())
    }))).into_response())
}

/// Mount only inside the X-Token guard or the peer-checked tailnet listener.
/// Dropping the guard retires this listener's pending turns on shutdown/rebind.
pub(crate) fn routes(
    app: &AppState,
    transport: Transport,
    cancel: &CancellationToken,
) -> (Router<AppState>, DropGuard) {
    let cancel = cancel.child_token();
    let inbox = Arc::new(Inbox {
        transport,
        cancel: cancel.clone(),
        state: Mutex::default(),
        changed: watch::Sender::new(()),
        poll_slots: Semaphore::new(4),
    });
    if let Some(chat) = &app.chat {
        let mut connections = chat.muse.0.lock().unwrap();
        connections.retain(|entry| entry.upgrade().is_some_and(|i| !i.cancel.is_cancelled()));
        connections.push(Arc::downgrade(&inbox));
    }
    let (incoming, reply) = transport.paths();
    let routes = Router::new()
        .route(incoming, get(pending))
        .route(reply, post(accept).layer(DefaultBodyLimit::max(64 * 1024)))
        .layer(Extension(inbox));
    (routes, cancel.drop_guard())
}

async fn pending(
    State(app): State<AppState>,
    Extension(inbox): Extension<Arc<Inbox>>,
    method: axum::http::Method,
    axum::extract::Query(query): axum::extract::Query<InboxQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    running(&app)?;
    let is_get = method == axum::http::Method::GET;
    let wait = query.duration(&headers);
    let mut changed = inbox.changed.subscribe();
    let slot = inbox.poll_slots.try_acquire().ok();
    let deadline = tokio::time::Instant::now() + wait;
    let items = loop {
        if inbox.cancel.is_cancelled() {
            return Err(Error::new(503, "MUSE_OFFLINE", "Muse 连接已关闭"));
        }
        let items = inbox.items(is_get);
        if !items.is_empty() || !is_get || slot.is_none() || tokio::time::Instant::now() >= deadline
        {
            break items;
        }
        tokio::select! {
            _ = inbox.cancel.cancelled() => continue,
            _ = tokio::time::sleep_until(deadline) => {},
            _ = changed.changed() => {},
        }
    };
    let (_, reply) = inbox.transport.paths();
    Ok(Json(json!({"ok":true, "items":items, "operations":{
        "reply":format!("POST {reply}"), "replyBody":{"requestKey":"来信编号","text":"角色回复"},
        "inboxWaitSeconds":if slot.is_some() {wait.as_secs()} else {0},
        "usage":"桌面与 QQ 分开持续收信。GET 收件地址加 ?wait=25，空收件箱返回后立即续接。有来信时按 conversationId 和 messages 回答，文字写好即 POST。每个 requestKey 只生成一次，失败重试沿用原文。"
    }})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    request_key: String,
    text: String,
}

async fn accept(
    State(app): State<AppState>,
    Extension(inbox): Extension<Arc<Inbox>>,
    Json(reply): Json<Reply>,
) -> Result<Json<Value>> {
    running(&app)?;
    let key = Uuid::parse_str(&reply.request_key).map_err(|_| Error::invalid("来信编号无效"))?;
    let text = reply.text.trim();
    if text.is_empty() || text.chars().count() > 12000 {
        return Err(Error::invalid("Muse 文字回复须为 1 至 12000 字"));
    }
    let expired = || Error::new(410, "MUSE_TURN_EXPIRED", "这条桌面提问已停止或到期");
    let now = Instant::now();
    let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();
    let mut state = inbox.state.lock().unwrap();
    state.receipts.retain(|r| r.deadline > now);
    if let Some(receipt) = state.receipts.iter().find(|r| r.key == key) {
        if receipt.digest != digest {
            return Err(Error::new(
                409,
                "MUSE_REPLY_CONFLICT",
                "此提问已接收另一条回复",
            ));
        }
    } else {
        let index = state
            .pending
            .iter()
            .position(|p| p.key == key && p.deadline > now)
            .ok_or_else(expired)?;
        let pending = state.pending.remove(index);
        pending
            .answer
            .send(text.to_owned())
            .map_err(|_| expired())?;
        if let Some(listed) = pending.listed_at {
            eprintln!(
                "Desktop Muse stage=reply_received requestKey={key} sinceListedMs={}",
                now.duration_since(listed).as_millis()
            );
        }
        if state.receipts.len() == 256 {
            state.receipts.pop_front();
        }
        state.receipts.push_back(Receipt {
            key,
            digest,
            deadline: pending.deadline,
        });
    }
    Ok(Json(
        json!({"ok":true, "requestKey":key.to_string(), "status":"accepted"}),
    ))
}
