mod gateway;

use super::{
    conversation::{Context, Conversation, Reply, batch_message},
    *,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use reqwest::Client;
use std::{collections::HashMap, sync::Arc};
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
    scope: QqScope,
    received_at: u64,
    text: String,
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
    fn parse(event: &Value) -> Option<Self> {
        let data = &event["d"];
        if data["author"]["bot"] == true {
            return None;
        }
        let (scope, target, member) = match event["t"].as_str()? {
            "C2C_MESSAGE_CREATE" => {
                let peer = open_id(&data["author"]["user_openid"])?;
                (QqScope::Private, peer, peer)
            }
            "GROUP_AT_MESSAGE_CREATE" => (
                QqScope::Group,
                open_id(&data["group_openid"])?,
                open_id(&data["author"]["member_openid"])?,
            ),
            _ => return None,
        };
        let id = data["id"].as_str()?.trim();
        let text = data["content"].as_str()?.trim();
        let now = crate::host::now_ms();
        let received_at = data["timestamp"]
            .as_str()
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .and_then(|time| u64::try_from(time.timestamp_millis()).ok())
            .unwrap_or(now)
            .min(now);
        if id.is_empty()
            || id.len() > 512
            || text.is_empty()
            || now.saturating_sub(received_at) >= scope.reply_window_ms()
        {
            return None;
        }
        Some(Self {
            id: id.into(),
            target: target.into(),
            member: member.into(),
            scope,
            text: text.chars().take(1600).collect(),
            received_at,
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
    let worker_cancel = cancel.clone();
    let worker_app = app.clone();
    let worker_storage = storage.clone();
    let worker_api = api.clone();
    let worker = tokio::spawn(async move {
        let handle = async {
            tokio::join!(
                process(
                    &worker_app,
                    &worker_storage,
                    &principal,
                    settings.clone(),
                    &worker_api,
                    &worker_cancel,
                    QqScope::Private,
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
            result = gateway::connect(&app, &storage, &api, &direct_sender, &group_sender, &mut resume) => result,
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
        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
        delay = (delay * 2).min(30);
    }
    cancel.cancel();
    let _ = worker.await;
}

async fn process(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    mut settings: Settings,
    api: &Api,
    cancel: &CancellationToken,
    scope: QqScope,
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
                if let Some((requested_scope, code)) = message.pairing_request() {
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
        let media = api.image(target, name, bytes).await?;
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

impl Api {
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
        .await?;
        let token = response["access_token"]
            .as_str()
            .filter(|token| !token.is_empty() && token.len() <= 4096)
            .ok_or_else(|| ApiError::invalid("QQ 凭据验证失败"))?;
        let expires = response["expires_in"]
            .as_u64()
            .or_else(|| response["expires_in"].as_str()?.parse().ok())
            .unwrap_or(300);
        *cached = Some((
            token.into(),
            Instant::now() + Duration::from_secs(expires.clamp(40, 10_000).saturating_sub(30)),
        ));
        Ok(token.into())
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let token = self.token().await?;
        let method = self
            .client
            .post(format!("{API}{path}"))
            .header("authorization", format!("QQBot {token}"))
            .json(&body);
        json_response(method).await
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
        let value = self.post(&target.path("messages"), body).await?;
        if value["id"].as_str().is_some_and(|id| !id.is_empty()) {
            Ok(())
        } else {
            Err(networking())
        }
    }

    async fn image(&self, target: Destination<'_>, name: &str, bytes: Vec<u8>) -> Result<String> {
        let value = self.post(&target.path("files"), json!({
            "file_type":1,"file_name":name,"file_data":STANDARD.encode(bytes),"srv_send_msg":false,
        })).await?;
        value["file_info"]
            .as_str()
            .filter(|media| !media.is_empty())
            .map(str::to_owned)
            .ok_or_else(networking)
    }
}

async fn json_response(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request.send().await.map_err(|_| networking())?;
    if !response.status().is_success() {
        return Err(networking());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| networking())?;
        if body.len() + chunk.len() > 64 * 1024 {
            return Err(networking());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| networking())
}

fn networking() -> ApiError {
    ApiError::new(502, "QQ_NETWORK", "QQ 消息服务暂不可用")
}
