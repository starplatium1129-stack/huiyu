use super::{
    conversation::{Context, Conversation, Reply, batch_message},
    *,
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::HeaderMap,
    routing::post,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::net::SocketAddr;

#[derive(Serialize, Deserialize)]
struct Settings {
    character: String,
    enabled: bool,
    drawing: bool,
    token_hash: Option<String>,
    pair_hash: Option<String>,
    expires: u64,
    owner: Option<(String, String)>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            character: "nene".into(),
            enabled: false,
            drawing: false,
            token_hash: None,
            pair_hash: None,
            expires: 0,
            owner: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    character: String,
    enabled: bool,
    drawing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    account: String,
    peer: String,
    id: String,
    text: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/companion-channels/wechat/message",
        post(message).layer(DefaultBodyLimit::max(16 * 1024)),
    )
}

pub(super) async fn configure(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    method: &Method,
    path: &[String],
    body: &[u8],
) -> Result<Value> {
    let _lock = app.channels.write.lock().await;
    let file = settings_file(app, storage, principal);
    let mut settings: Settings = read(&file).await?.unwrap_or_default();
    let mut details = Value::Null;
    match (method.as_str(), path) {
        ("GET" | "HEAD", []) => {}
        ("PUT", []) => {
            let change: Change = serde_json::from_slice(body)?;
            if !matches!(change.character.as_str(), "nene" | "natsume") {
                return Err(ApiError::invalid("请选择陪伴角色"));
            }
            let _admission = app.host.admit()?;
            settings.character = change.character;
            settings.enabled = change.enabled;
            settings.drawing = change.drawing;
            write(&file, &settings).await?;
            reset_turns(app);
        }
        ("POST", [action]) if action == "key" => {
            let _admission = app.host.admit()?;
            if !settings.enabled {
                return Err(ApiError::invalid("请先启用并保存微信连接"));
            }
            let first = uuid::Uuid::new_v4().simple();
            let second = uuid::Uuid::new_v4().simple();
            let token = format!("{first}{second}");
            let code = uuid::Uuid::new_v4().simple().to_string()[..12].to_owned();
            settings.token_hash = Some(tag(&token));
            settings.pair_hash = Some(tag(&code));
            settings.expires = crate::host::now_ms() + 15 * 60_000;
            settings.owner = None;
            write(&file, &settings).await?;
            reset_turns(app);
            details = json!({"token":token,"pairCode":code,"pairExpiresAt":settings.expires});
        }
        _ => return Err(ApiError::new(404, "CHANNEL_ROUTE", "找不到微信连接选项")),
    }
    Ok(
        json!({"ok":true,"enabled":settings.enabled,"drawing":settings.drawing,
        "character":settings.character,"keyCreated":settings.token_hash.is_some(),"paired":settings.owner.is_some(),
        "origin":app.config.gateway_origin,"credentials":details}),
    )
}

async fn message(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    // A local service bridge uses a dedicated bearer and accepts no browser calls or proxies.
    let denied = || ApiError::new(403, "WECHAT_BRIDGE_AUTH", "微信桥接未启用或连接密钥无效");
    if headers.contains_key("origin") || !crate::security::is_direct_local(&headers, peer.ip()) {
        return Err(denied());
    }
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| value.len() == 64)
        .ok_or_else(denied)?;
    let principal = principal(&app).ok_or_else(denied)?;
    let storage = app.host.storage().ok_or_else(denied)?;
    let input: Message = serde_json::from_slice(&bytes)?;
    if [&input.account, &input.peer, &input.id]
        .iter()
        .any(|value| value.is_empty() || value.len() > 512 || value.chars().any(char::is_control))
        || input.text.chars().count() > 2000
        || input.text.trim().is_empty()
    {
        return Err(ApiError::invalid("微信消息格式无效"));
    }
    let (settings, cancel) = {
        let _lock = app.channels.write.lock().await;
        let file = settings_file(&app, &storage, &principal);
        let mut settings = read::<Settings>(&file)
            .await?
            .filter(|settings| {
                settings.enabled && matches_tag(token, settings.token_hash.as_deref())
            })
            .ok_or_else(denied)?;
        if let Some(code) = input.text.trim().strip_prefix("/绑定 ") {
            if settings.owner.is_some()
                || settings.expires <= crate::host::now_ms()
                || !matches_tag(code.trim(), settings.pair_hash.as_deref())
            {
                return Ok(Json(
                    json!({"text":"绑定口令无效或已用过，请在绘遇重新生成。","images":[]}),
                ));
            }
            let _admission = app.host.admit()?;
            if !is_current(&app, &storage) {
                return Err(denied());
            }
            settings.owner = Some((input.account, input.peer));
            settings.pair_hash = None;
            write(&file, &settings).await?;
            return Ok(Json(
                json!({"text":"微信已绑定绘遇。可以直接发文字，或发送 /帮助。","images":[]}),
            ));
        }
        if !settings
            .owner
            .as_ref()
            .is_some_and(|(account, peer)| account == &input.account && peer == &input.peer)
        {
            return Ok(Json(
                json!({"text":"请先发送绘遇中复制的微信绑定命令。","images":[]}),
            ));
        }
        (
            settings,
            app.channels.wechat_cancel.lock().unwrap().child_token(),
        )
    };
    let _turn = match app.channels.wechat_turn.try_lock() {
        Ok(turn) => turn,
        Err(_) => {
            return Ok(Json(
                json!({"text":"上一条消息还在处理，请稍后再发。","images":[]}),
            ));
        }
    };
    if !is_current(&app, &storage) {
        return Err(denied());
    }
    let _guard = cancel.clone().drop_guard();
    let ctx = Context {
        app: &app,
        storage: &storage,
        principal: &principal,
        character: &settings.character,
        drawing: settings.drawing,
        group_member: None,
        cancel: &cancel,
    };
    let mut conversation = Conversation::open(&ctx, "wechat", &input.account, &input.peer).await?;
    let text = input.text.trim();
    let page = if text == "/取图" {
        Some(1)
    } else {
        text.strip_prefix("/取图 ")
            .and_then(|page| page.trim().parse::<usize>().ok())
            .filter(|page| (1..=16).contains(page))
    };
    let work = async {
        let reply = conversation
            .receive(
                &ctx,
                &input.id,
                crate::host::now_ms(),
                if page.is_some() { "/取图" } else { text },
            )
            .await?;
        let value = match reply {
            None => json!({"text":"","images":[]}),
            Some(Reply::Text(text)) => json!({"text":text,"images":[]}),
            Some(Reply::Results(batch)) => results(&ctx, &batch, page.unwrap_or(1)).await?,
        };
        Ok::<_, ApiError>(value)
    };
    let value = tokio::select! {
        _ = app.shutdown.cancelled() => return Err(denied()),
        _ = cancel.cancelled() => return Err(denied()),
        result = tokio::time::timeout(Duration::from_secs(180), work) => result
            .map_err(|_| ApiError::new(504, "WECHAT_BRIDGE_TIMEOUT", "绘遇处理消息超时"))??,
    };
    let saved = read::<Settings>(&settings_file(&app, &storage, &principal)).await?;
    if !is_current(&app, &storage)
        || !saved.is_some_and(|saved| {
            saved.enabled
                && saved.owner == settings.owner
                && saved.token_hash == settings.token_hash
        })
    {
        return Err(denied());
    }
    Ok(Json(value))
}

async fn results(ctx: &Context<'_>, batch: &Value, page: usize) -> Result<Value> {
    if matches!(
        batch["state"].as_str(),
        Some("running" | "cancelling" | "paused" | "draft")
    ) || batch.is_null()
    {
        return Ok(json!({"text":batch_message(batch),"images":[]}));
    }
    let aliases = batch["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|job| job["status"] == "succeeded")
        .filter_map(|job| job["imageId"].as_str())
        .collect::<Vec<_>>();
    let mut images = Vec::new();
    let next = page * 3;
    for alias in aliases.iter().skip(next - 3).take(3) {
        let (name, bytes) = super::media::read_image(ctx.storage, alias, ctx.cancel).await?;
        images.push(json!({"name":name,"data":STANDARD.encode(bytes)}));
    }
    let text = if images.is_empty() {
        "这一页没有成图。".into()
    } else if aliases.len() > next {
        format!(
            "这批有 {} 张。发 /取图 {} 看下一页。",
            aliases.len(),
            page + 1
        )
    } else {
        format!("这批有 {} 张，原图在绘遇作品册。", aliases.len())
    };
    Ok(json!({"text":text,"images":images}))
}

fn settings_file(app: &AppState, storage: &Storage, principal: &str) -> PathBuf {
    state_path(app, storage, principal, &json!(["wechat", "settings"]))
}
fn reset_turns(app: &AppState) {
    std::mem::take(&mut *app.channels.wechat_cancel.lock().unwrap()).cancel();
}
fn mac(value: &str) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(b"huiyu-wechat-bridge").unwrap();
    mac.update(value.as_bytes());
    mac
}
fn tag(value: &str) -> String {
    hex::encode(mac(value).finalize().into_bytes())
}
fn matches_tag(value: &str, tag: Option<&str>) -> bool {
    tag.and_then(|tag| hex::decode(tag).ok())
        .is_some_and(|tag| mac(value).verify_slice(&tag).is_ok())
}
