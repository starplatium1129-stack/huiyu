mod gateway;
mod members;
pub(super) mod muse;

use super::{
    conversation::{Context, Conversation, Reply, batch_message},
    *,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use reqwest::Client;
use std::{borrow::Cow, collections::HashMap, sync::Arc};
use tokio::sync::{Mutex as AsyncMutex, mpsc};
use tokio::time::Instant;

const API: &str = "https://api.bot.qq.com";
const CONNECTION_ERROR: &str = "QQ 连接中断，正在自动重连";

struct Api {
    client: Client,
    app_id: String,
    secret: String,
    token: AsyncMutex<Option<(String, Instant)>>,
}

struct Message {
    id: String,
    target: String,
    member: String,
    nickname: Option<String>,
    group_role: Option<&'static str>,
    scope: QqScope,
    to_muse: bool,
    ambient: bool,
    sent_at: Option<u64>,
    received_at: u64,
    arrived_at: Instant,
    text: String,
    images: Vec<Value>,
}

struct Inboxes {
    private_muse: bool,
    group_muse: bool,
    group_muse_all: bool,
    direct: mpsc::Sender<Message>,
    groups: mpsc::Sender<Message>,
    muse: mpsc::Sender<Message>,
}

impl Inboxes {
    fn for_message(&self, message: &Message) -> (&mpsc::Sender<Message>, &'static str) {
        match message.scope {
            // The private worker checks its current owner before forwarding to Muse,
            // including immediately after a successful pairing in the same session.
            QqScope::Private => (&self.direct, "private"),
            QqScope::Group if message.to_muse => (&self.muse, "muse"),
            QqScope::Group => (&self.groups, "local-group"),
        }
    }
}

#[derive(Clone, Copy)]
struct Destination<'a> {
    scope: QqScope,
    id: &'a str,
}

impl QqScope {
    fn reply_window_ms(self) -> u64 {
        match self {
            Self::Private => 60 * 60_000,
            Self::Group => 5 * 60_000,
        }
    }

    fn conversation_channel(self) -> &'static str {
        match self {
            Self::Private => "qq",
            Self::Group => "qq-group",
        }
    }
}

impl Destination<'_> {
    fn path(self, resource: &str) -> String {
        let segment = match self.scope {
            QqScope::Private => "users",
            QqScope::Group => "groups",
        };
        format!("/v2/{segment}/{}/{resource}", self.id)
    }
}

impl Message {
    fn muse_question(text: &str, enabled: bool) -> Option<&str> {
        let (command, question) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
        match command {
            "/帮助" | "/help" | "/取图" | "/开始绘图" | "/取消" | "/绑定" | "/绑定群" => {
                None
            }
            command if command.eq_ignore_ascii_case("/muse") => Some(question.trim()),
            _ if enabled => Some(text),
            _ => None,
        }
    }

    fn parse(
        kind: &str,
        data: &Value,
        bot_id: Option<&str>,
        inboxes: &Inboxes,
    ) -> std::result::Result<Self, &'static str> {
        if data["author"]["bot"] == true {
            return Err("bot-author");
        }
        let author = &data["author"];
        let (scope, target, member) = match kind {
            "C2C_MESSAGE_CREATE" => {
                let peer = open_id(&author["user_openid"])
                    .or_else(|| open_id(&author["id"]))
                    .ok_or("invalid-sender")?;
                (QqScope::Private, peer, peer)
            }
            "GROUP_AT_MESSAGE_CREATE" | "GROUP_MESSAGE_CREATE" => (
                QqScope::Group,
                open_id(&data["group_openid"]).ok_or("invalid-group")?,
                open_id(&author["member_openid"])
                    .or_else(|| open_id(&author["id"]))
                    .ok_or("invalid-sender")?,
            ),
            _ => return Err("unsupported-event"),
        };
        let id = event_message_id(data).ok_or("invalid-message-id")?;
        let enabled = match scope {
            QqScope::Private => inboxes.private_muse,
            QqScope::Group => inboxes.group_muse,
        };
        let text = data["content"].as_str().unwrap_or("").trim();
        let (content, mentioned) = if scope == QqScope::Group {
            group_text(
                text,
                &data["mentions"],
                bot_id,
                kind == "GROUP_AT_MESSAGE_CREATE",
            )
        } else {
            (Cow::Borrowed(text), false)
        };
        let ambient = kind == "GROUP_MESSAGE_CREATE" && !mentioned;
        if ambient && !(inboxes.group_muse && inboxes.group_muse_all) {
            return Err("ambient-disabled");
        }
        let now = crate::host::now_ms();
        let sent_at = data["timestamp"]
            .as_str()
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .and_then(|time| u64::try_from(time.timestamp_millis()).ok())
            .or_else(|| {
                let value = data["timestamp"]
                    .as_u64()
                    .or_else(|| data["timestamp"].as_str()?.parse().ok())?;
                Some(if value < 10_000_000_000 {
                    value * 1000
                } else {
                    value
                })
            });
        let received_at = sent_at.unwrap_or(now).min(now);
        if now.saturating_sub(received_at) >= scope.reply_window_ms() {
            return Err("reply-window-expired");
        }
        let attachments = &data["attachments"];
        let images = if enabled {
            incoming_images(attachments)
        } else {
            Vec::new()
        };
        let no_attachments =
            attachments.is_null() || attachments.as_array().is_some_and(Vec::is_empty);
        let text = match content.trim() {
            "" if enabled && mentioned && no_attachments => "@了你。",
            "" if images.is_empty() => return Err("empty-or-unsupported-content"),
            text => text,
        };
        let question = Self::muse_question(text, enabled);
        if ambient && question.is_none() {
            // Unaddressed group commands must never pair a group or control a drawing.
            return Err("ambient-command");
        }
        Ok(Self {
            id: id.into(),
            target: target.into(),
            member: member.into(),
            group_role: members::role(&author["member_role"]),
            nickname: [
                &author["member_nickname"],
                &data["member"]["nick"],
                &author["nickname"],
                &author["username"],
            ]
            .into_iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .find(|name| !name.is_empty())
            .map(|name| name.chars().take(128).collect()),
            scope,
            to_muse: question.is_some(),
            ambient,
            sent_at,
            text: question
                .map(|q| {
                    if q.is_empty() && !images.is_empty() {
                        format!("发来了 {} 张图片。", images.len())
                    } else {
                        q.to_owned()
                    }
                })
                .unwrap_or_else(|| text.chars().take(1600).collect()),
            images,
            received_at,
            arrived_at: Instant::now(),
        })
    }

    fn destination(&self) -> Destination<'_> {
        Destination {
            scope: self.scope,
            id: &self.target,
        }
    }

    fn pairing_request(&self) -> Option<(QqScope, &str)> {
        let (verb, code) = self.text.split_once(char::is_whitespace)?;
        let scope = match verb {
            "/绑定" => QqScope::Private,
            "/绑定群" => QqScope::Group,
            _ => return None,
        };
        Some((scope, code.trim()))
    }
}

fn incoming_images(attachments: &Value) -> Vec<Value> {
    attachments
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let mime = item["content_type"].as_str()?;
            if !mime.starts_with("image/") {
                return None;
            }
            let raw = item["url"].as_str()?.trim();
            if raw.len() > 4096 {
                return None;
            }
            let url = url::Url::parse(raw).ok()?;
            let host = url.domain()?;
            let qq_cdn = ["qq.com", "qq.com.cn", "qpic.cn", "qlogo.cn"]
                .iter()
                .any(|domain| {
                    host == *domain
                        || host
                            .strip_suffix(domain)
                            .is_some_and(|prefix| prefix.ends_with('.'))
                });
            if !qq_cdn
                || !matches!(url.scheme(), "https" | "http")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return None;
            }
            Some(json!({"mimeType":mime,"url":raw}))
        })
        .take(4)
        .collect()
}

fn group_text<'a>(
    text: &'a str,
    mentions: &Value,
    bot_id: Option<&str>,
    at_event: bool,
) -> (Cow<'a, str>, bool) {
    let mentions = mentions.as_array();
    let own = mentions.into_iter().flatten().find(|mention| {
        mention["is_you"] == true
            || bot_id.is_some_and(|id| {
                mention["member_openid"].as_str() == Some(id) || mention["id"].as_str() == Some(id)
            })
    });
    let mut content = Cow::Borrowed(text);
    let mut mentioned = at_event || own.is_some();
    if text.contains("<@") && (mentioned || mentions.is_none_or(Vec::is_empty)) {
        for id in [
            own.and_then(|mention| open_id(&mention["member_openid"])),
            own.and_then(|mention| open_id(&mention["id"])),
            bot_id,
        ]
        .into_iter()
        .flatten()
        {
            for token in [format!("<@{id}>"), format!("<@!{id}>")] {
                if content.contains(&token) {
                    content = Cow::Owned(content.replace(&token, ""));
                    mentioned = true;
                }
            }
        }
    }
    (content, mentioned)
}

fn event_message_id(data: &Value) -> Option<&str> {
    data["id"]
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 512)
}

fn message_tag(id: &str) -> String {
    let mut digest = crate::storage::json_fingerprint(&json!(id));
    digest.truncate(12);
    digest
}

fn muse_sender_id(conversation: &str, member: &str) -> String {
    crate::storage::json_fingerprint(&json!([conversation, member]))
}

fn open_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        (1..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

pub(super) async fn run(
    app: AppState,
    storage: Storage,
    principal: String,
    settings: Settings,
    cancel: CancellationToken,
) {
    let Ok(secret) = secret::open(&settings.sealed_secret) else {
        app.channels.report(
            &storage,
            "error",
            Some("无法读取本机 AppSecret，请重新保存"),
        );
        return;
    };
    let Ok(client) = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
    else {
        app.channels
            .report(&storage, "error", Some("QQ 网络连接初始化失败"));
        return;
    };
    let api = Arc::new(Api {
        client,
        app_id: settings.app_id.clone(),
        secret,
        token: AsyncMutex::new(None),
    });
    let (direct_sender, direct) = mpsc::channel(16);
    let (group_sender, groups) = mpsc::channel(16);
    let (muse_sender, muse_inbox) = mpsc::channel(16);
    let inboxes = Inboxes {
        private_muse: settings.private_muse,
        group_muse: settings.group_muse,
        group_muse_all: settings.group_muse_all,
        direct: direct_sender,
        groups: group_sender,
        muse: muse_sender.clone(),
    };
    if settings.private_muse || settings.group_muse {
        let _lock = app.channels.write.lock().await;
        if read::<Settings>(&settings_path(&app, &storage, &principal))
            .await
            .ok()
            .flatten()
            .is_none_or(|saved| !saved.same_connection(&settings))
            || !is_current(&app, &storage)
            || cancel.is_cancelled()
        {
            return;
        }
        let mailbox =
            muse::Mailbox::open(&app, &storage, &principal, &settings, api.clone(), &cancel).await;
        *app.channels.muse_qq.lock().unwrap() = Some(Arc::new(mailbox));
    }
    let worker_cancel = cancel.clone();
    let worker_app = app.clone();
    let worker_storage = storage.clone();
    let worker_api = api.clone();
    let worker = tokio::spawn(async move {
        let handle = async {
            tokio::join!(
                muse::process(
                    &worker_app,
                    &worker_storage,
                    &principal,
                    &worker_api,
                    muse_inbox
                ),
                process(
                    &worker_app,
                    &worker_storage,
                    &principal,
                    settings.clone(),
                    &worker_api,
                    &worker_cancel,
                    QqScope::Private,
                    &muse_sender,
                    direct
                ),
                process(
                    &worker_app,
                    &worker_storage,
                    &principal,
                    settings,
                    &worker_api,
                    &worker_cancel,
                    QqScope::Group,
                    &muse_sender,
                    groups
                ),
            );
        };
        tokio::select! { _ = worker_cancel.cancelled() => {}, _ = handle => {} }
    });
    let mut resume = gateway::Resume::default();
    let mut delay = 1;
    while !cancel.is_cancelled() && is_current(&app, &storage) {
        app.channels.report(&storage, "connecting", None);
        let result = tokio::select! {
            _ = cancel.cancelled() => break,
            result = gateway::connect(&app, &storage, &api, &inboxes, &mut resume) => result,
        };
        if cancel.is_cancelled() {
            break;
        }
        let detail = match result {
            Err(error) => error,
            Ok(()) => CONNECTION_ERROR,
        };
        app.channels.report(&storage, "error", Some(detail));
        if std::mem::take(&mut resume.connected) {
            delay = 1;
        }
        if delay == 1 {
            eprintln!("QQ WebSocket 等待重连：{detail}");
        }
        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
        delay = (delay * 2).min(30);
    }
    cancel.cancel();
    let _ = worker.await;
    app.channels.close_muse_qq();
}

async fn process(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    mut settings: Settings,
    api: &Api,
    cancel: &CancellationToken,
    scope: QqScope,
    muse: &mpsc::Sender<Message>,
    mut inbox: mpsc::Receiver<Message>,
) {
    let ctx = Context {
        app,
        storage,
        principal,
        character: &settings.character,
        drawing: if scope == QqScope::Group {
            settings.group_drawing
        } else {
            settings.drawing
        },
        group_member: None,
        cancel,
    };
    let mut conversations = HashMap::<String, Conversation>::new();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    while is_current(app, storage) && !cancel.is_cancelled() {
        tokio::select! {
            message = inbox.recv() => {
                let Some(message) = message else { return };
                let target = message.destination();
                if !message.to_muse && let Some((requested_scope, code)) = message.pairing_request() {
                    if requested_scope == scope
                        && let Ok(Some(binding)) = pair(app, storage, principal, &settings.app_id, scope, target.id, code).await
                    {
                        let reply = match scope {
                            QqScope::Private => {
                                settings.owner = binding.owner;
                                conversations.clear();
                                "已绑定绘遇。现在可以直接发消息，或发送 /帮助 查看用法。"
                            }
                            QqScope::Group => {
                                settings.groups = binding.groups;
                                "本群已绑定绘遇。@ 我就能聊天，也可以 @ 我发 /帮助。"
                            }
                        };
                        let _ = api.text(target, &message.id, reply).await;
                    }
                    continue;
                }
                if !allows(&settings, target) { continue; }
                if message.to_muse {
                    if muse.send(message).await.is_err() { return; }
                    continue;
                }
                let turn = Context { group_member: (scope == QqScope::Group).then_some(message.member.as_str()), ..ctx };
                let Ok(active) = conversation(&mut conversations, &turn, &settings.app_id, target).await else { continue };
                reply(&turn, api, active, &message).await;
            }
            _ = tick.tick() => {
                let ids = match scope {
                    QqScope::Private => settings.owner.iter().map(String::as_str).collect::<Vec<_>>(),
                    QqScope::Group => settings.groups.iter().map(|group| group.id.as_str()).collect(),
                };
                for id in ids {
                    let target = Destination { scope, id };
                    if let Ok(active) = conversation(&mut conversations, &ctx, &settings.app_id, target).await {
                        notify(&ctx, api, active, target).await;
                    }
                }
            }
        }
    }
}

fn allows(settings: &Settings, target: Destination<'_>) -> bool {
    match target.scope {
        QqScope::Private => settings.owner.as_deref() == Some(target.id),
        QqScope::Group => settings.groups.iter().any(|group| group.id == target.id),
    }
}

async fn conversation<'a>(
    conversations: &'a mut HashMap<String, Conversation>,
    ctx: &Context<'_>,
    app_id: &str,
    target: Destination<'_>,
) -> Result<&'a mut Conversation> {
    use std::collections::hash_map::Entry;
    match conversations.entry(target.id.into()) {
        Entry::Occupied(entry) => Ok(entry.into_mut()),
        Entry::Vacant(entry) => {
            let record =
                Conversation::open(ctx, target.scope.conversation_channel(), app_id, target.id)
                    .await?;
            Ok(entry.insert(record))
        }
    }
}

async fn reply(ctx: &Context<'_>, api: &Api, active: &mut Conversation, message: &Message) {
    let target = message.destination();
    let turn = active.receive(ctx, &message.id, message.received_at, &message.text);
    let available = target
        .scope
        .reply_window_ms()
        .saturating_sub(crate::host::now_ms().saturating_sub(message.received_at));
    if available < 10_000 {
        return;
    }
    let action = tokio::time::timeout(Duration::from_millis(available - 8000), turn).await;
    if !is_current(ctx.app, ctx.storage) {
        return;
    }
    match action {
        Ok(Ok(Some(Reply::Text(text)))) => {
            let _ = api.text(target, &message.id, &text).await;
        }
        Ok(Ok(Some(Reply::Results(batch)))) => {
            let _ = deliver(ctx, api, active, target, &message.id, &batch, false).await;
        }
        Ok(Ok(None)) => {}
        Ok(Err(error)) => {
            let text = if error.submission_not_accepted
                || error.status.is_client_error()
                    && matches!(
                        error.code.as_str(),
                        "TOOL_PERMISSION_DENIED" | "LOCAL_NATIVE_REQUIRED" | "INVALID_REQUEST"
                    ) {
                error.message
            } else {
                "绘遇暂时无法完成这条消息。请检查本机聊天模型或绘图服务后重试。".into()
            };
            let _ = api.text(target, &message.id, &text).await;
        }
        Err(_) => {
            let _ = api
                .text(
                    target,
                    &message.id,
                    "回复超时了，可以再发一次。已经提交的绘图可以发 /取图 核对。",
                )
                .await;
        }
    }
}

async fn notify(ctx: &Context<'_>, api: &Api, active: &mut Conversation, target: Destination<'_>) {
    let Some(ticket) = active.batch().filter(|batch| !batch.notified).cloned() else {
        return;
    };
    if crate::host::now_ms().saturating_sub(ticket.received_at)
        > target.scope.reply_window_ms().saturating_sub(15_000)
    {
        let _ = active.remember_delivery(0, true).await;
        return;
    }
    let Ok(batch) = active.current_batch(ctx).await else {
        return;
    };
    if matches!(
        batch["state"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    ) {
        let _ = deliver(ctx, api, active, target, &ticket.message_id, &batch, true).await;
    }
}

async fn deliver(
    ctx: &Context<'_>,
    api: &Api,
    active: &mut Conversation,
    target: Destination<'_>,
    message_id: &str,
    batch: &Value,
    automatic: bool,
) -> Result<()> {
    if !is_current(ctx.app, ctx.storage) {
        return Ok(());
    }
    if matches!(
        batch["state"].as_str(),
        Some("running" | "cancelling" | "paused" | "draft")
    ) || batch.is_null()
    {
        return api.text(target, message_id, &batch_message(batch)).await;
    }
    let images = batch["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|job| job["status"] == "succeeded")
        .filter_map(|job| job["imageId"].as_str())
        .collect::<Vec<_>>();
    let departed = active.batch().map_or(0, |value| value.delivered);
    let remaining = images.len().saturating_sub(departed);
    let seq = if automatic { 2 } else { 1 };
    if !automatic {
        let notice = if remaining > 3 {
            format!("还有 {remaining} 张可领取，这次发 3 张。再发 /取图 继续领取。")
        } else if remaining == 0 && !images.is_empty() {
            "这批成图已全部回传，可在绘遇作品册查看。".into()
        } else if remaining == 0 {
            "这批绘图已结束，没有可回传的成图。".into()
        } else {
            format!("这批有 {remaining} 张成图，现在发给你。")
        };
        api.text(target, message_id, &notice).await?;
    } else {
        // Automatic delivery uses the original message's remaining three replies.
        // A new /取图 command can recover any receipt that QQ never confirmed.
        active.remember_delivery(0, true).await?;
        if remaining == 0 {
            return api
                .send(
                    target,
                    message_id,
                    seq,
                    json!({"msg_type":0,"content":"这批绘图已结束，没有可回传的成图。"}),
                )
                .await;
        }
    }
    for (index, alias) in images.into_iter().skip(departed).take(3).enumerate() {
        if !is_current(ctx.app, ctx.storage) {
            return Ok(());
        }
        let (name, bytes) = super::media::read_image(ctx.storage, alias, ctx.cancel).await?;
        let media = api
            .upload_media(target, MediaKind::Image, name, &bytes)
            .await?;
        api.send(
            target,
            message_id,
            2 + index as u8,
            json!({"msg_type":7,"media":{"file_info":media}}),
        )
        .await?;
        active.remember_delivery(1, false).await?;
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Image = 1,
    Audio = 3,
}

impl MediaKind {
    fn name(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
        }
    }
}

impl Api {
    fn conversation_id(&self, scope: QqScope, id: &str) -> String {
        // Keep existing group conversation IDs across upgrades.
        let identity = match scope {
            QqScope::Group => json!([self.app_id, id]),
            QqScope::Private => json!([self.app_id, "private", id]),
        };
        crate::storage::json_fingerprint(&identity)
    }

    async fn token(&self) -> Result<String> {
        let mut cached = self.token.lock().await;
        if let Some((token, expiry)) = &*cached
            && *expiry > Instant::now()
        {
            return Ok(token.clone());
        }
        let response = json_response(
            self.client
                .post("https://bots.qq.com/app/getAppAccessToken")
                .json(&json!({"appId":self.app_id,"clientSecret":self.secret})),
        )
        .await
        .map_err(|error| {
            if error.status.as_u16() == 429 || !error.status.is_client_error() {
                error
            } else {
                ApiError::new(
                    401,
                    "QQ_CREDENTIALS",
                    format!("QQ 未能验证 AppID 或 AppSecret。{}", error.message),
                )
            }
        })?;
        let token = response["access_token"]
            .as_str()
            .filter(|token| !token.is_empty() && token.len() <= 4096)
            .ok_or_else(|| ApiError::new(502, "QQ_CREDENTIALS", "QQ 凭据回执缺少访问令牌"))?;
        let expires = response["expires_in"]
            .as_u64()
            .or_else(|| response["expires_in"].as_str()?.parse().ok())
            .unwrap_or(300);
        let expires = expires.min(10_000);
        let refresh_after = expires - (expires / 10).min(30);
        *cached = Some((
            token.into(),
            Instant::now() + Duration::from_secs(refresh_after),
        ));
        Ok(token.into())
    }

    async fn authenticated(&self, mut request: reqwest::RequestBuilder) -> Result<Value> {
        let mut retry = request.try_clone();
        loop {
            let token = self.token().await.map_err(ApiError::not_accepted)?;
            let result =
                json_response(request.header("authorization", format!("QQBot {token}"))).await;
            if !result
                .as_ref()
                .is_err_and(|error| error.code == "QQ_TOKEN_REJECTED")
            {
                return result;
            }
            let mut cached = self.token.lock().await;
            if cached
                .as_ref()
                .is_some_and(|(current, _)| current == &token)
            {
                *cached = None;
            }
            drop(cached);
            let Some(next) = retry.take() else {
                return result;
            };
            request = next;
        }
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.authenticated(self.client.post(format!("{API}{path}")).json(&body))
            .await
    }

    async fn text(&self, target: Destination<'_>, id: &str, text: &str) -> Result<()> {
        let text: String = text.chars().take(1600).collect();
        self.send(target, id, 1, json!({"msg_type":0,"content":text}))
            .await
    }

    async fn send(
        &self,
        target: Destination<'_>,
        id: &str,
        seq: u8,
        mut body: Value,
    ) -> Result<()> {
        body["msg_id"] = json!(id);
        body["msg_seq"] = json!(seq);
        self.send_message(target, body).await
    }

    async fn proactive(&self, target: Destination<'_>, mut body: Value) -> Result<()> {
        let fields = body
            .as_object_mut()
            .ok_or_else(|| ApiError::invalid("QQ 主动消息格式不正确").not_accepted())?;
        for field in ["msg_id", "msg_seq", "event_id", "is_wakeup"] {
            fields.remove(field);
        }
        self.send_message(target, body).await.map_err(|mut error| {
            if !error.submission_not_accepted {
                error.code = "QQ_DELIVERY_UNKNOWN".into();
                error.message = format!("请先在 QQ 会话核对送达情况。{}", error.message);
            }
            error
        })
    }

    async fn send_message(&self, target: Destination<'_>, mut body: Value) -> Result<()> {
        // QQ's older rich-media handlers require a nonempty content field.
        if body["msg_type"] == 7 && body["content"].as_str().is_none_or(str::is_empty) {
            body["content"] = json!(" ");
        }
        let value = self.post(&target.path("messages"), body).await?;
        if value["id"].as_str().is_some_and(|id| !id.is_empty()) {
            Ok(())
        } else {
            Err(ApiError::new(
                502,
                "QQ_RECEIPT_MISSING",
                "QQ 回执缺少消息 ID",
            ))
        }
    }

    async fn upload_media(
        &self,
        target: Destination<'_>,
        kind: MediaKind,
        name: &str,
        bytes: &[u8],
    ) -> Result<String> {
        let value = self.post(&target.path("files"), json!({
            "file_type":kind as u8,"file_name":name,"file_data":STANDARD.encode(bytes),"srv_send_msg":false,
        })).await.map_err(ApiError::not_accepted)?;
        value["file_info"]
            .as_str()
            .filter(|media| !media.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| networking().not_accepted())
    }
}

async fn json_response(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request.send().await.map_err(|error| {
        if error.is_builder() || error.is_connect() && !error.is_timeout() {
            networking().not_accepted()
        } else {
            networking()
        }
    })?;
    let status = response.status();
    let unreadable = || {
        if status.is_success() {
            ApiError::new(
                502,
                "QQ_RECEIPT_MISSING",
                format!("QQ 回执无法读取（HTTP {}）", status.as_u16()),
            )
        } else {
            rejected(status, None)
        }
    };
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| unreadable())?;
        if body.len() + chunk.len() > 64 * 1024 {
            return Err(unreadable());
        }
        body.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice::<Value>(&body);
    let code = value.as_ref().ok().and_then(|data| {
        ["err_code", "code"]
            .into_iter()
            .filter_map(|field| {
                let value = &data[field];
                value
                    .as_i64()
                    .or_else(|| value.as_str()?.parse::<i64>().ok())
            })
            .find(|code| *code != 0)
    });
    if !status.is_success() || code.is_some() {
        return Err(rejected(status, code));
    }
    value.map_err(|_| unreadable())
}

fn rejected(status: reqwest::StatusCode, code: Option<i64>) -> ApiError {
    let http = status.as_u16();
    let (local_status, name, detail) = match (http, code) {
        (500..=599 | 408, _) => (502, "QQ_NETWORK", "QQ 服务未能确认请求结果"),
        (_, Some(304023 | 304024)) => (409, "QQ_AUDIT_PENDING", "QQ 已受理消息，正在审核"),
        (401, _) | (_, Some(11241 | 11242 | 11243)) => {
            (401, "QQ_TOKEN_REJECTED", "QQ 拒绝了访问令牌")
        }
        (429, _) | (_, Some(22009 | 40034100 | 40093002)) => {
            (429, "QQ_RATE_LIMIT", "已达到 QQ 发送限额，请稍后重试")
        }
        (_, Some(304027 | 304103 | 40034005 | 40034128)) => {
            (410, "QQ_REPLY_EXPIRED", "QQ 原消息的回复时间或次数已用完")
        }
        (_, Some(40054005)) => (409, "QQ_MESSAGE_DUPLICATE", "QQ 已使用这条消息的回复序号"),
        (_, Some(304003 | 40054010)) => (
            422,
            "QQ_URL_REJECTED",
            "QQ 未允许这条链接，请检查机器人后台的消息 URL 配置",
        ),
        (_, Some(850019 | 850031 | 304080)) => (
            422,
            "QQ_MEDIA_INVALID",
            "QQ 无法使用这份媒体文件，请检查文件格式和大小",
        ),
        (_, Some(304082 | 304083 | 850026 | 850027 | 40034004 | 40093001)) => (
            502,
            "QQ_MEDIA_UNAVAILABLE",
            "QQ 未能完成媒体转存，可以稍后重试",
        ),
        (_, Some(40034101 | 40054003 | 40054004)) => (
            403,
            "QQ_TARGET_UNAVAILABLE",
            "QQ 机器人尚未加入这个群或与该用户建立好友关系",
        ),
        (_, Some(304064 | 40034105 | 40054013)) => (
            403,
            "QQ_PROACTIVE_DENIED",
            "请检查机器人的主动发送权限和会话的消息接收开关",
        ),
        (403, _) | (_, Some(11253 | 11254 | 11264 | 11265 | 40054002 | 850018)) => {
            (403, "QQ_PERMISSION_DENIED", "QQ 机器人当前没有发送权限")
        }
        (_, Some(40034006 | 304061 | 40054007 | 40054018)) => (
            422,
            "QQ_CONTENT_REJECTED",
            "QQ 拒绝了这条内容，请调整正文或缩短消息",
        ),
        (_, Some(40054016 | 50055001 | 50055002)) => {
            (503, "QQ_SEND_UNAVAILABLE", "QQ 当前无法发送，请稍后重试")
        }
        _ => (422, "QQ_REJECTED", "QQ 拒绝了这次请求"),
    };
    let reason = match code {
        Some(code) => format!("HTTP {http}，QQ {code}"),
        None => format!("HTTP {http}"),
    };
    eprintln!("QQ 请求未取得成功回执：{reason}");
    let error = ApiError::new(local_status, name, format!("{detail}（{reason}）"));
    if status.is_server_error() || http == 408 || name == "QQ_AUDIT_PENDING" {
        error
    } else {
        error.not_accepted()
    }
}

fn networking() -> ApiError {
    ApiError::new(502, "QQ_NETWORK", "QQ 消息服务暂不可用")
}
