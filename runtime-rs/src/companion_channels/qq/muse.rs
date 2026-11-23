use super::*;
mod attachment;
mod history;
mod http;
mod ingest;
mod lookup;
mod outbox;
mod poll;
mod replies;
mod vm;
use crate::chat::muse::tailnet;
use axum::{Json, Router, extract::State};
use http::{Channel, operations};
pub(crate) use http::{router, tailnet_router};
pub(super) use ingest::process;
use replies::{expired, reply_window};
use std::{
    collections::VecDeque,
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::{Semaphore, watch};

const INBOX_LIMIT: usize = 128;
const EXPIRED_REPLY_GRACE_MS: u64 = 120_000;
// Leave space for inbox operations and the JSON envelope in the relay's 2 MiB response.
const INBOX_ITEMS_BYTES: usize = 2 * 1024 * 1024 - 16 * 1024;
const MESSAGE_JSON_LIMIT: usize = 4 * 1024 * 1024 + 64 * 1024;

pub(in crate::companion_channels) struct Mailbox {
    epoch: String,
    api: Arc<Api>,
    cancel: CancellationToken,
    entries: Mutex<VecDeque<Arc<Entry>>>,
    group_members: Mutex<VecDeque<GroupMember>>,
    history: history::History,
    inbox_changed: watch::Sender<()>,
    poll_slots: Semaphore,
    last_poll: AtomicU64,
    route: Route,
}

enum Route {
    Pull,
    Vm(vm::Endpoint),
    VmPoll(vm::PeerConfig),
    Invalid,
}

type Nicknames = HashMap<String, HashMap<String, String>>;

struct GroupMember {
    conversation_id: String,
    sender_id: String,
    openid: String,
}

struct Entry {
    key: String,
    message_id: String,
    target: String,
    scope: QqScope,
    ambient: bool,
    sender_openid: String,
    nickname: Option<String>,
    sender_role: &'static str,
    timestamp: u64,
    conversation_id: String,
    sender_id: String,
    question: String,
    recent_messages: Vec<Arc<Value>>,
    images: Vec<Value>,
    search: Option<OnceLock<Value>>,
    attach_nene: bool,
    expires_at: u64,
    arrived_at: Instant,
    listed: AtomicBool,
    send_attempted: AtomicBool,
    delivery: AsyncMutex<Delivery>,
}

#[derive(Default)]
struct Delivery {
    text: Option<TextDelivery>,
    confirmed: bool,
    media: Option<attachment::MediaDelivery>,
    needs_media: bool,
    skipped: bool,
}

#[derive(PartialEq, Eq)]
struct TextAnswer {
    text: String,
    mention_sender_id: Option<String>,
}

struct TextDelivery {
    answer: TextAnswer,
    message: Value,
}

struct Target {
    conversation_id: String,
    scope: QqScope,
    id: String,
    label: String,
}

fn scope_name(scope: QqScope) -> &'static str {
    match scope {
        QqScope::Group => "group",
        QqScope::Private => "private",
    }
}

impl Entry {
    fn trace(&self, stage: &str) {
        eprintln!(
            "QQ Muse stage={stage} requestKey={} sinceIngressMs={}",
            self.key,
            self.arrived_at.elapsed().as_millis()
        );
    }

    fn destination(&self) -> Destination<'_> {
        Destination {
            scope: self.scope,
            id: &self.target,
        }
    }

    fn sender_fields(&self) -> Value {
        json!({"senderId":self.sender_id,"senderNickname":self.nickname,
               "senderRole":(self.scope == QqScope::Group).then_some(self.sender_role)})
    }

    fn public_question(&self) -> Value {
        let mut item = self.sender_fields();
        item["requestKey"] = json!(self.key);
        item["conversationId"] = json!(self.conversation_id);
        item["scope"] = json!(scope_name(self.scope));
        item["ambient"] = json!(self.ambient);
        item["text"] = json!(self.question);
        item["timestamp"] = json!(self.timestamp);
        item["expiresAt"] = json!(self.expires_at);
        item["recentMessages"] = json!(self.recent_messages);
        if !self.images.is_empty() {
            item["attachments"] = json!(self.images);
        }
        if let Some(result) = self.search.as_ref().and_then(OnceLock::get) {
            // Older Muse clients only read text. Keep a short, attributed digest there too.
            item["userText"] = json!(self.question);
            item["text"] = json!(lookup::with_sources(&self.question, result));
            item["webSearch"] = result.clone();
        }
        item
    }

    fn vm_question(&self) -> Value {
        let mut item = self.public_question();
        if self.scope == QqScope::Group {
            item["groupOpenid"] = json!(self.target);
        } else {
            item["userOpenid"] = json!(self.target);
        }
        item["senderOpenid"] = json!(self.sender_openid);
        item["messageId"] = json!(self.message_id);
        item
    }

    fn done(&self, delivery: &Delivery) -> bool {
        delivery.skipped
            || delivery.media.as_ref().is_some_and(|media| media.confirmed)
            || (delivery.confirmed && !self.attach_nene && !delivery.needs_media)
    }
}

impl Mailbox {
    pub(super) async fn open(
        app: &AppState,
        storage: &Storage,
        principal: &str,
        settings: &Settings,
        api: Arc<Api>,
        cancel: &CancellationToken,
    ) -> Self {
        let route = match vm::load(&app.config.runtime_root).await {
            Ok(route) => route,
            Err(error) => {
                eprintln!("Muse 群聊虚拟机配置读取失败：{error}");
                Route::Invalid
            }
        };
        let history_path = state_path(
            app,
            storage,
            principal,
            &json!(["qq", "muse-history", api.app_id]),
        )
        .with_extension("sqlite3");
        let history =
            history::History::open(history_path, settings.muse_history_generation.clone()).await;
        Self {
            epoch: storage.runtime_epoch().to_owned(),
            api,
            cancel: cancel.child_token(),
            entries: Mutex::default(),
            group_members: Mutex::default(),
            history,
            inbox_changed: watch::Sender::new(()),
            poll_slots: Semaphore::new(4),
            last_poll: AtomicU64::new(0),
            route,
        }
    }

    fn vm_peer(&self) -> Option<tailnet::Peer> {
        match &self.route {
            Route::VmPoll(endpoint) => Some(endpoint.peer),
            Route::Vm(endpoint) => Some(endpoint.callback.peer),
            _ => None,
        }
    }

    pub(in crate::companion_channels) fn close(&self) {
        self.cancel.cancel();
        self.entries.lock().unwrap().clear();
    }

    pub(in crate::companion_channels) fn status(
        &self,
        app: &AppState,
        storage: &Storage,
    ) -> &'static str {
        if self.epoch != storage.runtime_epoch() || self.cancel.is_cancelled() {
            return "waiting";
        }
        match &self.route {
            Route::Vm(endpoint) => endpoint.status(),
            Route::Invalid => "vmConfigError",
            Route::Pull if !crate::images::remote::listening() => "remoteDisabled",
            Route::VmPoll(endpoint) if !tailnet::listening(app, endpoint.peer) => "vmUnavailable",
            Route::Pull | Route::VmPoll(_)
                if crate::host::now_ms().saturating_sub(self.last_poll.load(Ordering::Relaxed))
                    < 90_000 =>
            {
                "receiving"
            }
            Route::Pull | Route::VmPoll(_) => "waiting",
        }
    }

    fn require_pull(&self) -> Result<()> {
        match &self.route {
            Route::Pull => Ok(()),
            Route::Vm(_) => Err(ApiError::new(
                409,
                "QQ_MUSE_VM_ACTIVE",
                "此通道已改由绘遇向 Muse 虚拟机投递和取回回复",
            )),
            Route::VmPoll(_) => Err(ApiError::new(
                409,
                "QQ_MUSE_VM_POLL",
                "Muse 已改用笔记本的 Tailscale /qq/pending 和 /qq/replies",
            )),
            Route::Invalid => Err(ApiError::new(
                503,
                "QQ_MUSE_VM_CONFIG",
                "请检查本机 muse-qq-vm.json 配置",
            )),
        }
    }

    fn current(app: &AppState) -> Result<Arc<Self>> {
        app.host.check_available()?;
        let storage = app.host.storage();
        app.channels
            .muse_qq
            .lock()
            .unwrap()
            .as_ref()
            .filter(|mailbox| {
                !mailbox.cancel.is_cancelled()
                    && storage
                        .as_ref()
                        .is_some_and(|s| s.runtime_epoch() == mailbox.epoch)
            })
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    409,
                    "QQ_MUSE_DISABLED",
                    "请在绘遇启用 QQ 连接，选择交给 Muse 的对话并保存",
                )
            })
    }

    async fn settings(&self, app: &AppState) -> Result<Settings> {
        let storage = app.host.storage().ok_or_else(expired)?;
        let principal = principal(app).ok_or_else(expired)?;
        let _lock = app.channels.write.lock().await;
        let current = Self::current(app)?;
        if !std::ptr::eq(self, current.as_ref()) {
            return Err(expired());
        }
        read_bot_by_app_id(app, &storage, &principal, &self.api.app_id)
            .await?
            .filter(|s| s.enabled)
            .ok_or_else(expired)
    }

    fn targets(&self, settings: &Settings) -> Vec<Target> {
        let mut targets = Vec::new();
        let mut add = |scope, id: &str, label: &str| {
            targets.push(Target {
                conversation_id: self.api.conversation_id(scope, id),
                scope,
                id: id.to_owned(),
                label: label.to_owned(),
            })
        };
        if settings.private_muse
            && let Some(owner) = &settings.owner
        {
            add(QqScope::Private, owner, "已绑定的私聊");
        }
        if settings.group_muse {
            for group in &settings.groups {
                add(QqScope::Group, &group.id, &group.label);
            }
        }
        targets
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, VecDeque<Arc<Entry>>> {
        let mut entries = self.entries.lock().unwrap();
        let now = crate::host::now_ms();
        entries.retain(|item| item.expires_at.saturating_add(EXPIRED_REPLY_GRACE_MS) > now);
        entries
    }

    fn pending(&self, item: fn(&Entry) -> Value, record_listed: bool) -> Vec<Value> {
        let now = crate::host::now_ms();
        let ready: Vec<_> = self
            .entries()
            .iter()
            .filter(|entry| {
                entry.expires_at > now
                    && entry.search.as_ref().is_none_or(|s| s.get().is_some())
                    && entry
                        .delivery
                        .try_lock()
                        .is_ok_and(|delivery| !entry.done(&delivery))
            })
            .take(16)
            .cloned()
            .collect();
        let mut items = Vec::with_capacity(ready.len());
        let multiple = ready.len() > 1;
        let mut remaining = INBOX_ITEMS_BYTES;
        let mut encoded = Vec::new();
        for entry in ready {
            let value = item(&entry);
            if multiple {
                encoded.clear();
                serde_json::to_writer(&mut encoded, &value)
                    .expect("JSON value can be written to Vec");
                let bytes = encoded.len() + 1;
                if bytes > remaining && !items.is_empty() {
                    break;
                }
                remaining = remaining.saturating_sub(bytes);
            }
            if record_listed && !entry.listed.swap(true, Ordering::Relaxed) {
                entry.trace("inbox_listed");
            }
            items.push(value);
        }
        items
    }

    fn entry(&self, key: &str) -> Result<Arc<Entry>> {
        self.entries()
            .iter()
            .find(|entry| entry.key == key)
            .cloned()
            .ok_or_else(expired)
    }

    fn text_message(
        &self,
        scope: QqScope,
        conversation_id: &str,
        text: &str,
        mention_sender_id: Option<&str>,
    ) -> Result<Value> {
        let Some(sender_id) = mention_sender_id else {
            return Ok(json!({"msg_type":0,"content":text}));
        };
        if scope != QqScope::Group {
            return Err(ApiError::invalid("只能在 QQ 群聊中 @ 成员").not_accepted());
        }
        let members = self.group_members.lock().unwrap();
        let member = members
            .iter()
            .find(|member| {
                member.conversation_id == conversation_id && member.sender_id == sender_id
            })
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "QQ_MUSE_MENTION_UNKNOWN",
                    "这次连接还没有收到此成员在该群的发言",
                )
                .not_accepted()
            })?;
        // Keep any angle-bracket tags in the reply literal. Only the gateway inserts the mention.
        let escaped = text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let content = format!(r#"<qqbot-at-user id="{}" /> {escaped}"#, member.openid);
        Ok(json!({"msg_type":2,"markdown":{"content":content}}))
    }
}

pub(crate) async fn configured_peer(root: &Path) -> Result<Option<tailnet::Peer>> {
    vm::configured_peer(root).await
}
