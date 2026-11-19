use super::*;
mod lookup;
mod outbox;
mod picture;
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
        atomic::{AtomicU64, Ordering},
    },
};

const INBOX_LIMIT: usize = 128;
const MESSAGE_JSON_LIMIT: usize = 4 * 1024 * 1024 + 64 * 1024;

pub(in crate::companion_channels) struct Mailbox {
    epoch: String,
    api: Arc<Api>,
    cancel: CancellationToken,
    entries: Mutex<VecDeque<Arc<Entry>>>,
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
    timestamp: u64,
    conversation_id: String,
    sender_id: String,
    question: String,
    images: Vec<Value>,
    search: Option<OnceLock<Value>>,
    attach_nene: bool,
    expires_at: u64,
    delivery: AsyncMutex<Delivery>,
}

#[derive(Default)]
struct Delivery {
    text: Option<String>,
    confirmed: bool,
    image: Option<picture::ImageDelivery>,
    needs_image: bool,
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

impl Entry {
    fn destination(&self) -> Destination<'_> {
        Destination {
            scope: self.scope,
            id: &self.target,
        }
    }

    fn public_question(&self) -> Value {
        let mut item = json!({
            "requestKey":self.key,"conversationId":self.conversation_id,"senderId":self.sender_id,
            "scope":scope_name(self.scope),"ambient":self.ambient,"text":self.question,"expiresAt":self.expires_at
        });
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

    fn vm_question(&self, names: &Nicknames) -> Value {
        let nickname = self.nickname.as_deref().or_else(|| {
            names
                .get(&self.target)?
                .get(&self.sender_openid)
                .map(String::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
        });
        let mut item = self.public_question();
        if self.scope == QqScope::Group {
            item["groupOpenid"] = json!(self.target);
        } else {
            item["userOpenid"] = json!(self.target);
        }
        item["senderOpenid"] = json!(self.sender_openid);
        item["senderNickname"] = json!(nickname);
        item["messageId"] = json!(self.message_id);
        item["timestamp"] = json!(self.timestamp);
        item
    }

    fn done(&self, delivery: &Delivery) -> bool {
        delivery.skipped
            || delivery.image.as_ref().is_some_and(|image| image.confirmed)
            || (delivery.confirmed && !self.attach_nene && !delivery.needs_image)
    }
}

impl Mailbox {
    pub(super) async fn open(
        root: &Path,
        storage: &Storage,
        api: Arc<Api>,
        cancel: &CancellationToken,
    ) -> Self {
        let route = match vm::load(root).await {
            Ok(route) => route,
            Err(error) => {
                eprintln!("Muse 群聊虚拟机配置读取失败：{error}");
                Route::Invalid
            }
        };
        Self {
            epoch: storage.runtime_epoch().to_owned(),
            api,
            cancel: cancel.child_token(),
            entries: Mutex::default(),
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

    fn conversation_id(&self, scope: QqScope, id: &str) -> String {
        // Keep existing group conversation IDs across upgrades.
        let identity = match scope {
            QqScope::Group => json!([self.api.app_id, id]),
            QqScope::Private => json!([self.api.app_id, "private", id]),
        };
        crate::storage::json_fingerprint(&identity)
    }

    fn targets(&self, settings: &Settings) -> Vec<Target> {
        let mut targets = Vec::new();
        let mut add = |scope, id: &str, label: &str| {
            targets.push(Target {
                conversation_id: self.conversation_id(scope, id),
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

    fn pending(&self, item: impl Fn(&Entry) -> Value) -> Vec<Value> {
        self.entries()
            .iter()
            .filter_map(|entry| {
                let delivery = entry.delivery.try_lock().ok()?;
                let ready = entry.search.as_ref().is_none_or(|s| s.get().is_some());
                (ready && !entry.done(&delivery)).then(|| item(entry))
            })
            .take(16)
            .collect()
    }

    fn entry(&self, key: &str) -> Result<Arc<Entry>> {
        self.entries()
            .iter()
            .find(|entry| entry.key == key)
            .cloned()
            .ok_or_else(expired)
    }

    fn enqueue(
        self: &Arc<Self>,
        app: &AppState,
        message: &Message,
        question: &str,
        character: &str,
        tasks: &mut tokio::task::JoinSet<()>,
    ) -> Option<&'static str> {
        match &self.route {
            Route::Invalid => {
                return Some(
                    "Muse 虚拟机配置无效，请机主检查 muse-qq-vm.json 后重新保存 QQ 连接。",
                );
            }
            Route::Pull if !crate::images::remote::listening() => {
                return Some("Muse 接口尚未启动。请机主在绘遇的原生绘图设置里开启「允许连接」。");
            }
            _ => {}
        }
        let mut entries = self.entries();
        if entries.iter().any(|entry| {
            entry.message_id == message.id
                && entry.scope == message.scope
                && entry.target == message.target
        }) {
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
            return Some("Muse 正在处理较多消息，请稍后再发。");
        }
        let expires_at = message.received_at + message.scope.reply_window_ms();
        if expires_at <= crate::host::now_ms() {
            return None;
        }
        let conversation_id = self.conversation_id(message.scope, &message.target);
        let sender_id = crate::storage::json_fingerprint(&json!([conversation_id, message.member]));
        let query = lookup::explicit_query(question).map(str::to_owned);
        let entry = Arc::new(Entry {
            key: uuid::Uuid::new_v4().to_string(),
            target: message.target.clone(),
            scope: message.scope,
            ambient: message.ambient,
            sender_openid: message.member.clone(),
            nickname: message.nickname.clone(),
            timestamp: message.sent_at.unwrap_or(message.received_at),
            message_id: message.id.clone(),
            conversation_id,
            sender_id,
            question: question.to_owned(),
            images: message.images.clone(),
            search: query.as_ref().map(|_| OnceLock::new()),
            attach_nene: matches!(self.route, Route::VmPoll(_))
                && picture::requests_nene_photo(question, character),
            expires_at,
            delivery: AsyncMutex::default(),
        });
        entries.push_back(entry.clone());
        if query.is_some() || matches!(&self.route, Route::Vm(_)) {
            let mailbox = self.clone();
            let app = app.clone();
            tasks.spawn(async move {
                if let (Some(query), Some(search)) = (query, &entry.search) {
                    let result = lookup::run(&app, &mailbox, Some(&entry), &query)
                        .await
                        .unwrap_or_else(|e| json!({"ok":false,"error":e.message}));
                    let _ = search.set(result);
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
    loop {
        let message = tokio::select! {
            Some(_) = forwarding.join_next(), if !forwarding.is_empty() => continue,
            next = inbox.recv() => match next { Some(message) => message, None => break },
        };
        let question = message.text.as_str();
        let notice = {
            let _lock = app.channels.write.lock().await;
            let Ok(Some(settings)) = read::<Settings>(&file).await else {
                continue;
            };
            if !is_current(app, storage)
                || !settings.enabled
                || settings.app_id != api.app_id
                || !allows(&settings, message.destination())
            {
                continue;
            }
            if !settings.muse_for(message.scope) {
                Some("这个对话还没有启用 Muse。可以请机主在绘遇的 QQ 连接设置里开启。")
            } else if question.is_empty() {
                Some("请 @ 我并写上问题，例如「今天画什么好？」。")
            } else if question.chars().nth(1600).is_some() {
                Some("Muse 每条提问最多 1600 字，请分开发送。")
            } else {
                match Mailbox::current(app) {
                    Ok(mailbox) => mailbox.enqueue(
                        app,
                        &message,
                        question,
                        &settings.character,
                        &mut forwarding,
                    ),
                    Err(_) => Some("Muse 群聊连接正在更新，请稍后再发。"),
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
        "reply":format!("POST {base}/{reply}"),"targets":format!("GET {base}/targets"),
        "send":format!("POST {base}/send"),"search":format!("POST {base}/search"),
        "replyBody":{"requestKey":"来信编号","text":"回复文字","image":{"mimeType":"image/png","data":"图片 Base64"}},
        "sendBody":{"requestKey":"新 UUID，重试沿用","conversationId":"targets 返回的会话","text":"文字，也可改传 image"},
        "searchBody":{"requestKey":"来信编号，或搭配 conversationId 使用新 UUID","query":"公开网页关键词"},
        "limits":{"textChars":1600,"imageBytes":super::super::media::IMAGE_LIMIT},
        "usage":"回复可选文字、图片或两者。无需回复可提交 requestKey 和 skip:true。主动发送每次选文字或图片，QQ 确认后才算送达。"
    })
}

async fn inbox(Channel(mailbox): Channel) -> Result<Json<Value>> {
    let (items, vm) = match &mailbox.route {
        Route::VmPoll(endpoint) => (
            mailbox.pending(|entry| entry.vm_question(&endpoint.names)),
            true,
        ),
        Route::Pull => (mailbox.pending(Entry::public_question), false),
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
        && vm
    {
        eprintln!("Muse 虚拟机已通过 Tailscale 首次收取 QQ 待答列表");
    }
    Ok(Json(
        json!({"ok":true,"items":items,"operations":operations(vm)}),
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

async fn send(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    Json(body): Json<outbox::SendBody>,
) -> Result<Json<Value>> {
    let _admission = app.host.admit_owned()?;
    outbox::send(&app, &mailbox, body).await
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplyBody {
    request_key: String,
    text: Option<String>,
    image: Option<picture::EncodedImage>,
    #[serde(default)]
    skip: bool,
}

async fn reply(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    Json(body): Json<ReplyBody>,
) -> Result<Json<Value>> {
    let _admission = app.host.admit_owned()?;
    submit_reply(&app, &mailbox, body).await
}

async fn submit_reply(app: &AppState, mailbox: &Mailbox, body: ReplyBody) -> Result<Json<Value>> {
    let entry = mailbox.entry(&body.request_key)?;
    let settings = mailbox.settings(app).await?;
    if !settings.muse_for(entry.scope) || !allows(&settings, entry.destination()) {
        return Err(expired());
    }
    if body.skip {
        if body.text.is_some() || body.image.is_some() {
            return Err(ApiError::invalid("跳过时只提交 requestKey 和 skip"));
        }
        let mut delivery = entry.delivery.lock().await;
        reply_window(app, mailbox, &entry)?;
        if delivery.text.is_some() || delivery.image.is_some() {
            return Err(ApiError::new(409, "QQ_MUSE_CONFLICT", "此消息已经开始回复"));
        }
        delivery.skipped = true;
        return Ok(Json(
            json!({"ok":true,"requestKey":entry.key,"status":"skipped"}),
        ));
    }
    let text = body.text.as_deref().map(str::trim);
    if text.is_some_and(|s| s.is_empty() || s.chars().count() > 1600)
        || text.is_none() && body.image.is_none()
    {
        return Err(ApiError::invalid("请提供图片或 1 到 1600 字的回复文字"));
    }
    let image = body.image.map(picture::EncodedImage::decode).transpose()?;
    if image.is_some() {
        entry.delivery.lock().await.needs_image = true;
    }
    if image.is_none() && text == Some(picture::NENE_COMMAND) {
        picture::send_nene(app, mailbox, &entry, picture::Selection::Exact).await?;
    } else {
        if let Some(text) = text {
            send_answer(app, mailbox, &entry, text).await?;
        }
        if let Some((mime, bytes)) = image {
            picture::send(
                app,
                mailbox,
                &entry,
                &mime,
                bytes,
                picture::Selection::Exact,
            )
            .await?;
        } else if entry.attach_nene {
            picture::send_nene(app, mailbox, &entry, picture::Selection::IfMissing).await?;
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
        if matches!(mailbox.route, Route::VmPoll(_)) {
            eprintln!("Muse 反向轮询回信已获 QQ 确认");
        }
    }
    Ok(())
}
