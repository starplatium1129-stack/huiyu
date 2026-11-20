use super::*;
mod attachment;
mod history;
mod lookup;
mod outbox;
mod poll;
mod vm;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, FromRequestParts, State},
    http::request::Parts,
    routing::{get, post},
};
use std::{
    collections::VecDeque,
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::{Semaphore, watch};

const INBOX_LIMIT: usize = 128;
// Leave space for inbox operations and the JSON envelope in the relay's 2 MiB response.
const INBOX_ITEMS_BYTES: usize = 2 * 1024 * 1024 - 16 * 1024;
const MESSAGE_JSON_LIMIT: usize = 4 * 1024 * 1024 + 64 * 1024;

pub(in crate::companion_channels) struct Mailbox {
    epoch: String,
    api: Arc<Api>,
    cancel: CancellationToken,
    entries: Mutex<VecDeque<Arc<Entry>>>,
    history: history::GroupHistory,
    inbox_changed: watch::Sender<()>,
    poll_slots: Semaphore,
    last_poll: AtomicU64,
    route: Route,
}

enum Route {
    Pull,
    Vm(vm::Endpoint),
    VmPoll(Arc<poll::Endpoint>),
    Invalid,
}

type Nicknames = HashMap<String, HashMap<String, String>>;

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
    delivery: AsyncMutex<Delivery>,
}

#[derive(Default)]
struct Delivery {
    text: Option<String>,
    confirmed: bool,
    media: Option<attachment::MediaDelivery>,
    needs_media: bool,
    skipped: bool,
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

impl Message {
    fn muse_filtered(&self, reason: &str) {
        eprintln!(
            "QQ Muse stage=filtered msg={} reason={reason}",
            message_tag(&self.id)
        );
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
        if self.scope == QqScope::Group {
            item["recentMessages"] = json!(self.recent_messages);
        }
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
            history::GroupHistory::open(history_path, settings.muse_history_generation.clone())
                .await;
        Self {
            epoch: storage.runtime_epoch().to_owned(),
            api,
            cancel: cancel.child_token(),
            entries: Mutex::default(),
            history,
            inbox_changed: watch::Sender::new(()),
            poll_slots: Semaphore::new(4),
            last_poll: AtomicU64::new(0),
            route,
        }
    }

    pub(super) fn start_listener(
        self: &Arc<Self>,
        app: &AppState,
    ) -> Option<tokio::task::JoinHandle<()>> {
        let endpoint = match &self.route {
            Route::VmPoll(endpoint) => endpoint,
            Route::Vm(endpoint) => &endpoint.callback,
            _ => return None,
        };
        Some(endpoint.start(app.clone(), self.clone()))
    }

    pub(in crate::companion_channels) fn close(&self) {
        self.cancel.cancel();
        self.entries.lock().unwrap().clear();
    }

    pub(in crate::companion_channels) fn status(&self, storage: &Storage) -> &'static str {
        if self.epoch != storage.runtime_epoch() || self.cancel.is_cancelled() {
            return "waiting";
        }
        match &self.route {
            Route::Vm(endpoint) => endpoint.status(),
            Route::Invalid => "vmConfigError",
            Route::Pull if !crate::images::remote::listening() => "remoteDisabled",
            Route::VmPoll(endpoint) if !endpoint.listening() => "vmUnavailable",
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
        read::<Settings>(&settings_path(app, &storage, &principal))
            .await?
            .filter(|s| s.enabled && s.app_id == self.api.app_id)
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
        entries.retain(|item| item.expires_at > now);
        entries
    }

    fn pending(&self, item: fn(&Entry) -> Value, record_listed: bool) -> Vec<Value> {
        let ready: Vec<_> = self
            .entries()
            .iter()
            .filter(|entry| {
                entry.search.as_ref().is_none_or(|s| s.get().is_some())
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

    async fn enqueue(
        self: &Arc<Self>,
        app: &AppState,
        message: &Message,
        question: &str,
        settings: &Settings,
        tasks: &mut tokio::task::JoinSet<()>,
    ) -> Option<&'static str> {
        match &self.route {
            Route::Invalid => {
                message.muse_filtered("invalid_route");
                return Some(
                    "Muse 虚拟机配置无效，请机主检查 muse-qq-vm.json 后重新保存 QQ 连接。",
                );
            }
            Route::Pull if !crate::images::remote::listening() => {
                message.muse_filtered("listener_disabled");
                return Some("Muse 接口尚未启动。请机主在绘遇的原生绘图设置里开启「允许连接」。");
            }
            _ => {}
        }
        if self.entries().iter().any(|entry| {
            entry.message_id == message.id
                && entry.scope == message.scope
                && entry.target == message.target
        }) {
            message.muse_filtered("duplicate");
            return None;
        }
        let expires_at = message.received_at + message.scope.reply_window_ms();
        if expires_at <= crate::host::now_ms() {
            message.muse_filtered("expired");
            return None;
        }
        let conversation_id = self.api.conversation_id(message.scope, &message.target);
        let sender_id = muse_sender_id(&conversation_id, &message.member);
        let nickname = message.nickname.clone().or_else(|| {
            let names = match &self.route {
                Route::Vm(endpoint) => &endpoint.callback.names,
                Route::VmPoll(endpoint) => &endpoint.names,
                _ => return None,
            };
            let name = names.get(&message.target)?.get(&message.member)?.trim();
            (!name.is_empty()).then(|| name.chars().take(128).collect())
        });
        let query = lookup::explicit_query(question).map(str::to_owned);
        let mut entry = Entry {
            key: uuid::Uuid::new_v4().to_string(),
            target: message.target.clone(),
            scope: message.scope,
            ambient: message.ambient,
            sender_openid: message.member.clone(),
            nickname,
            sender_role: message.group_role.unwrap_or("unknown"),
            timestamp: message.sent_at.unwrap_or(message.received_at),
            message_id: message.id.clone(),
            conversation_id,
            sender_id,
            question: question.to_owned(),
            recent_messages: Vec::new(),
            images: message.images.clone(),
            search: query.as_ref().map(|_| OnceLock::new()),
            attach_nene: matches!(self.route, Route::VmPoll(_))
                && attachment::requests_nene_photo(question, &settings.character),
            expires_at,
            arrived_at: message.arrived_at,
            listed: AtomicBool::new(false),
            delivery: AsyncMutex::default(),
        };
        if entry.scope == QqScope::Group {
            entry.recent_messages = self
                .history
                .receive(&entry, settings.muse_context_limit)
                .await;
        }
        let mut entries = self.entries();
        if self.cancel.is_cancelled() || entry.expires_at <= crate::host::now_ms() {
            message.muse_filtered("closed_or_expired");
            return None;
        }
        if entries.len() >= INBOX_LIMIT
            && (entries.len() >= INBOX_LIMIT * 8
                || entries
                    .iter()
                    .filter(|e| e.delivery.try_lock().map_or(true, |d| !e.done(&d)))
                    .count()
                    >= INBOX_LIMIT)
        {
            message.muse_filtered("inbox_full");
            return Some("Muse 正在处理较多消息，请稍后再发。");
        }
        let entry = Arc::new(entry);
        entries.push_back(entry.clone());
        drop(entries);
        eprintln!(
            "QQ Muse stage=enqueued msg={} requestKey={} recentMessages={} searchPending={}",
            message_tag(&message.id),
            entry.key,
            entry.recent_messages.len(),
            query.is_some()
        );
        if query.is_none() {
            self.inbox_changed.send_replace(());
        }
        if query.is_some() || matches!(&self.route, Route::Vm(_)) {
            let mailbox = self.clone();
            let app = app.clone();
            tasks.spawn(async move {
                if let (Some(query), Some(search)) = (query, &entry.search) {
                    let result = lookup::run(&app, &mailbox, Some(&entry), &query)
                        .await
                        .unwrap_or_else(|e| json!({"ok":false,"error":e.message}));
                    let _ = search.set(result);
                    entry.trace("search_ready");
                    mailbox.inbox_changed.send_replace(());
                }
                if let Route::Vm(endpoint) = &mailbox.route {
                    endpoint.forward(&app, &mailbox, &entry).await;
                }
            });
        }
        None
    }
}

// Read the binding at intake so unbinding takes effect even while the group chat
// worker is waiting for a model or delivering a batch of images.
pub(super) async fn process(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    api: &Api,
    mut inbox: mpsc::Receiver<Message>,
) {
    let file = settings_path(app, storage, principal);
    let mut forwarding = tokio::task::JoinSet::new();
    let mut members = members::Directory::default();
    loop {
        let mut message = tokio::select! {
            Some(_) = forwarding.join_next(), if !forwarding.is_empty() => continue,
            next = inbox.recv() => match next { Some(message) => message, None => break },
        };
        let notice = {
            let lock = app.channels.write.lock().await;
            let Ok(Some(settings)) = read::<Settings>(&file).await else {
                message.muse_filtered("settings_unavailable");
                continue;
            };
            if !is_current(app, storage) || !settings.enabled || settings.app_id != api.app_id {
                message.muse_filtered("connection_changed");
                continue;
            }
            if !allows(&settings, message.destination()) {
                message.muse_filtered("unbound");
                continue;
            }
            if message.ambient && !settings.group_muse_all {
                message.muse_filtered("ambient_disabled");
                continue;
            }
            if !settings.muse_for(message.scope) {
                message.muse_filtered("muse_disabled");
                Some("这个对话还没有启用 Muse。可以请机主在绘遇的 QQ 连接设置里开启。")
            } else if message.text.is_empty() {
                message.muse_filtered("missing_question");
                Some("请 @ 我并写上问题，例如「今天画什么好？」。")
            } else if message.text.chars().nth(1600).is_some() {
                message.muse_filtered("text_too_long");
                Some("Muse 每条提问最多 1600 字，请分开发送。")
            } else {
                match Mailbox::current(app) {
                    Ok(mailbox) => {
                        drop(lock);
                        members.enrich(api, &mut message).await;
                        if mailbox.cancel.is_cancelled() {
                            message.muse_filtered("connection_changed");
                            continue;
                        }
                        mailbox
                            .enqueue(app, &message, &message.text, &settings, &mut forwarding)
                            .await
                    }
                    Err(_) => {
                        message.muse_filtered("mailbox_unavailable");
                        Some("Muse 群聊连接正在更新，请稍后再发。")
                    }
                }
            }
        };
        if let Some(notice) = notice
            && !message.ambient
        {
            let _ = api.text(message.destination(), &message.id, notice).await;
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().nest("/api/muse/qq", routes("/inbox", "/reply"))
}

fn routes(inbox_path: &str, reply_path: &str) -> Router<AppState> {
    Router::new()
        .route(reply_path, post(reply))
        .route("/send", post(send))
        .layer(DefaultBodyLimit::max(MESSAGE_JSON_LIMIT))
        .route(inbox_path, get(inbox))
        .route("/targets", get(targets))
        .route("/context/{conversation_id}", get(history::context))
        .route(
            "/search",
            post(lookup::search).layer(DefaultBodyLimit::max(8 * 1024)),
        )
}

// Only the peer-authenticated Tailscale listener installs a mailbox extension.
// The remote/relay listener has its own X-Token check and must respect the selected route.
struct Channel(Arc<Mailbox>);

impl FromRequestParts<AppState> for Channel {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &AppState) -> Result<Self> {
        let mailbox = Mailbox::current(app)?;
        match parts.extensions.get::<Arc<Mailbox>>() {
            Some(bound) if !Arc::ptr_eq(bound, &mailbox) => return Err(expired()),
            Some(_) => {}
            None => mailbox.require_pull()?,
        }
        Ok(Self(mailbox))
    }
}

fn operations(vm: bool) -> Value {
    let base = if vm { "/qq" } else { "/api/muse/qq" };
    let reply = if vm { "replies" } else { "reply" };
    json!({
        "senderIdentity":"同群按 senderId 认人，senderNickname 用于称呼。群角色以 senderRole 为准：owner 群主，admin 管理员，member 普通成员，unknown 未核实。私聊为 null。",
        "reply":format!("POST {base}/{reply}"),"targets":format!("GET {base}/targets"),
        "send":format!("POST {base}/send"),"search":format!("POST {base}/search"),
        "replyBody":{"requestKey":"来信编号","text":"回复文字","image":{"mimeType":"image/png","data":"图片 Base64"}},
        "sendBody":{"requestKey":"新 UUID，重试沿用","conversationId":"targets 返回的会话","text":"文字，也可改传 image 或 audio"},
        "audio":{"mimeType":"audio/mpeg","data":"MP3 原文件的标准 Base64"},"searchBody":{"requestKey":"来信编号，或搭配 conversationId 使用新 UUID","query":"公开网页关键词"},
        "context":format!("GET {base}/context/{{conversationId}}"),
        "contextUsage":"recentMessages 按收录顺序附上这条消息之前的同群发言，数量由绘遇的群聊前文设置决定。需要更早的发言时可读取同群 context。",
        "inboxWaitSeconds":0,
        "desktopChat":if vm {
            json!({"inbox":"GET /desktop/pending","reply":"POST /desktop/replies"})
        } else {
            json!({"inbox":"GET /api/muse/desktop/inbox","reply":"POST /api/muse/desktop/reply"})
        },
        "limits":{"textChars":1600,"imageBytes":super::super::media::IMAGE_LIMIT,"audioBytes":attachment::AUDIO_LIMIT},
        "usage":"普通文字用来信中的 recentMessages 直接回答，写好即回传。回复可带文字和一个附件，image 与 audio 二选一，也可以只发附件。无需回复可提交 requestKey 和 skip:true。主动发送每次选文字、图片或语音，QQ 确认后才算送达。"
    })
}

async fn inbox(
    Channel(mailbox): Channel,
    method: Method,
    axum::extract::Query(query): axum::extract::Query<crate::chat::muse::InboxQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Value>> {
    let vm = match &mailbox.route {
        Route::VmPoll(_) => true,
        Route::Pull => false,
        _ => {
            return Err(ApiError::new(
                409,
                "QQ_MUSE_PUSH",
                "此模式会将问题直接投递到虚拟机",
            ));
        }
    };
    if mailbox
        .last_poll
        .swap(crate::host::now_ms(), Ordering::Relaxed)
        == 0
    {
        let path = if vm {
            "/qq/pending"
        } else {
            "/api/muse/qq/inbox"
        };
        eprintln!("QQ Muse stage=poll_started path={path}");
    }
    let render: fn(&Entry) -> Value = if vm {
        Entry::vm_question
    } else {
        Entry::public_question
    };
    // Subscribe before reading the queue so an arrival between the two cannot be missed.
    let mut changed = mailbox.inbox_changed.subscribe();
    let slot = mailbox.poll_slots.try_acquire().ok();
    let wait = query.duration(&headers);
    let deadline = Instant::now() + wait;
    let items = loop {
        if mailbox.cancel.is_cancelled() {
            return Err(expired());
        }
        let items = mailbox.pending(render, method == Method::GET);
        if !items.is_empty()
            || method != Method::GET
            || slot.is_none()
            || Instant::now() >= deadline
        {
            break items;
        }
        tokio::select! {
            _ = mailbox.cancel.cancelled() => return Err(expired()),
            _ = tokio::time::sleep_until(deadline) => {},
            _ = changed.changed() => {},
        }
    };
    let mut operations = operations(vm);
    operations["inboxWaitSeconds"] = json!(if slot.is_some() { wait.as_secs() } else { 0 });
    operations["inboxUsage"] = json!(
        "单独持续 GET 收件地址加 ?wait=25，HTTP 超时至少 40 秒。空结果立即续接，inboxWaitSeconds 为 0 时等 2 秒再取。"
    );
    Ok(Json(
        json!({"ok":true,"items":items,"operations":operations}),
    ))
}

async fn targets(State(app): State<AppState>, Channel(mailbox): Channel) -> Result<Json<Value>> {
    let settings = mailbox.settings(&app).await?;
    let targets: Vec<_> = mailbox.targets(&settings).into_iter().map(|target| json!({
        "conversationId":target.conversation_id,"scope":scope_name(target.scope),"label":target.label
    })).collect();
    Ok(Json(
        json!({"ok":true,"targets":targets,"proactiveEnabled":settings.muse_proactive}),
    ))
}

fn invalid_message_body(error: axum::extract::rejection::JsonRejection) -> ApiError {
    if error.status().as_u16() == 413 {
        ApiError::new(
            413,
            "QQ_MUSE_BODY_SIZE",
            "QQ 消息体过大，附件原文件上限为 3 MiB",
        )
    } else {
        ApiError::new(
            error.status().as_u16(),
            "QQ_MUSE_BODY_INVALID",
            "请使用 application/json，附件需含 mimeType 和 data 两个字符串",
        )
    }
}

async fn send(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    body: std::result::Result<Json<outbox::SendBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let _admission = app.host.admit_owned()?;
    outbox::send(&app, &mailbox, body.map_err(invalid_message_body)?.0).await
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplyBody {
    request_key: String,
    text: Option<String>,
    image: Option<attachment::EncodedFile>,
    audio: Option<attachment::EncodedFile>,
    #[serde(default)]
    skip: bool,
}

async fn reply(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    body: std::result::Result<Json<ReplyBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let _admission = app.host.admit_owned()?;
    submit_reply(&app, &mailbox, body.map_err(invalid_message_body)?.0).await
}

async fn submit_reply(app: &AppState, mailbox: &Mailbox, body: ReplyBody) -> Result<Json<Value>> {
    let entry = mailbox.entry(&body.request_key)?;
    let settings = mailbox.settings(app).await?;
    if !settings.muse_for(entry.scope) || !allows(&settings, entry.destination()) {
        return Err(expired());
    }
    entry.trace("reply_received");
    if body.skip {
        if body.text.is_some() || body.image.is_some() || body.audio.is_some() {
            return Err(ApiError::invalid("跳过时只提交 requestKey 和 skip"));
        }
        let mut delivery = entry.delivery.lock().await;
        reply_window(app, mailbox, &entry)?;
        if delivery.text.is_some() || delivery.media.is_some() {
            return Err(ApiError::new(409, "QQ_MUSE_CONFLICT", "此消息已经开始回复"));
        }
        delivery.skipped = true;
        entry.trace("skipped");
        return Ok(Json(
            json!({"ok":true,"requestKey":entry.key,"status":"skipped"}),
        ));
    }
    let text = body.text.as_deref().map(str::trim);
    if text.is_some_and(|s| s.is_empty() || s.chars().count() > 1600)
        || text.is_none() && body.image.is_none() && body.audio.is_none()
    {
        return Err(ApiError::invalid(
            "请提供语音、图片或 1 到 1600 字的回复文字",
        ));
    }
    let media = match (body.image, body.audio) {
        (Some(_), Some(_)) => return Err(ApiError::invalid("一次回复只能附带一张图片或一段语音")),
        (Some(image), None) => Some(image.decode(MediaKind::Image)?),
        (None, Some(audio)) => Some(audio.decode(MediaKind::Audio)?),
        (None, None) => None,
    };
    if media.is_some() {
        entry.delivery.lock().await.needs_media = true;
    }
    if media.is_none() && text == Some(attachment::NENE_COMMAND) {
        attachment::send_nene(app, mailbox, &entry, attachment::Selection::Exact).await?;
    } else {
        if let Some(text) = text {
            send_answer(app, mailbox, &entry, text).await?;
        }
        if let Some(file) = media {
            attachment::send(app, mailbox, &entry, file, attachment::Selection::Exact).await?;
        } else if entry.attach_nene {
            attachment::send_nene(app, mailbox, &entry, attachment::Selection::IfMissing).await?;
        }
    }
    Ok(Json(
        json!({"ok":true,"requestKey":entry.key,"status":"sent"}),
    ))
}

fn expired() -> ApiError {
    ApiError::new(
        410,
        "QQ_MUSE_EXPIRED",
        "消息已过期或绑定已更新，请群友重新提问",
    )
}

fn reply_window(app: &AppState, mailbox: &Mailbox, entry: &Entry) -> Result<Duration> {
    let remaining = entry.expires_at.saturating_sub(crate::host::now_ms());
    if remaining == 0
        || mailbox.cancel.is_cancelled()
        || !app
            .host
            .storage()
            .is_some_and(|s| s.runtime_epoch() == mailbox.epoch)
    {
        return Err(expired());
    }
    Ok(Duration::from_millis(remaining))
}

async fn send_answer(app: &AppState, mailbox: &Mailbox, entry: &Entry, text: &str) -> Result<()> {
    let mut delivery = entry.delivery.lock().await;
    let remaining = reply_window(app, mailbox, entry)?;
    if delivery.skipped {
        return Err(ApiError::new(409, "QQ_MUSE_SKIPPED", "此消息已经跳过"));
    }
    if delivery
        .text
        .as_deref()
        .is_some_and(|previous| previous != text)
    {
        return Err(ApiError::new(
            409,
            "QQ_MUSE_CONFLICT",
            "此消息已有另一条回复，重试请沿用原文",
        ));
    }
    if !delivery.confirmed {
        let retry = delivery.text.is_some();
        delivery.text = Some(text.to_owned());
        // Keep sequence 2 for compatibility with earlier gateways and replays.
        let send = mailbox.api.send(
            entry.destination(),
            &entry.message_id,
            2,
            json!({"msg_type":0,"content":text}),
        );
        let result = tokio::select! {
            biased;
            _ = mailbox.cancel.cancelled() => return Err(expired()),
            result = tokio::time::timeout(remaining, send) => result.map_err(|_| expired())?,
        };
        if let Err(error) = result
            && !(retry && error.code == "QQ_MESSAGE_DUPLICATE")
        {
            if error.submission_not_accepted || error.code == "QQ_MESSAGE_DUPLICATE" {
                delivery.text = None;
            }
            return Err(error);
        }
        delivery.confirmed = true;
        entry.trace("qq_text_confirmed");
        mailbox
            .remember_sent(entry.scope, &entry.conversation_id, "text", Some(text))
            .await;
    }
    Ok(())
}
