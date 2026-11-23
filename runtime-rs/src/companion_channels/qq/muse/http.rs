use super::replies::{ReplyBody, submit_reply};
use super::*;
use axum::{
    extract::{DefaultBodyLimit, FromRequestParts, State},
    http::request::Parts,
    routing::{get, post},
};

pub(crate) fn router() -> Router<AppState> {
    Router::new().nest("/api/muse/qq", routes("/inbox", "/reply"))
}

pub(crate) fn tailnet_router() -> Router<AppState> {
    Router::new().nest(
        "/qq",
        routes("/pending", "/replies").merge(poll::image_route()),
    )
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

// Only the Tailscale guard installs a verified peer. QQ still requires a
// live mailbox configured for that exact peer and port.
pub(super) struct Channel(pub(super) Arc<Mailbox>);

impl FromRequestParts<AppState> for Channel {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &AppState) -> Result<Self> {
        let mailbox = Mailbox::current(app)?;
        match parts.extensions.get::<tailnet::Peer>() {
            Some(peer) if mailbox.vm_peer() != Some(*peer) => return Err(expired()),
            Some(_) => {}
            None => mailbox.require_pull()?,
        }
        Ok(Self(mailbox))
    }
}

pub(super) fn operations(vm: bool) -> Value {
    let base = if vm { "/qq" } else { "/api/muse/qq" };
    let reply = if vm { "replies" } else { "reply" };
    json!({
        "senderIdentity":"同群按 senderId 认人，senderNickname 作称呼；senderRole：owner 群主 / admin 管理员 / member 成员 / unknown 未核实（私聊 null）。",
        "reply":format!("POST {base}/{reply}"),"targets":format!("GET {base}/targets"),
        "send":format!("POST {base}/send"),"search":format!("POST {base}/search"),
        "replyBody":{"requestKey":"来信编号","text":"回复文字","image":{"mimeType":"image/png","data":"图片 Base64"}},
        "sendBody":{"requestKey":"新 UUID，重试沿用","conversationId":"目标会话","text":"文字（或 image/audio）"},
        "mentionSenderId":"群文字回复或主动发言传同群 senderId 可附带 QQ @ 标签。",
        "audio":{"mimeType":"audio/mpeg","data":"MP3 标准 Base64"},"searchBody":{"requestKey":"来信编号，或新 UUID + conversationId","query":"关键词"},
        "context":format!("GET {base}/context/{{conversationId}}"),
        "contextUsage":"recentMessages 附带同会话前文（私聊近 1h ≤6 条）；更多群发言查同群 context。",
        "inboxWaitSeconds":0,
        "desktopChat":if vm {
            json!({"inbox":"GET /desktop/pending","reply":"POST /desktop/replies"})
        } else {
            json!({"inbox":"GET /api/muse/desktop/inbox","reply":"POST /api/muse/desktop/reply"})
        },
        "limits":{"textChars":1600,"imageBytes":crate::companion_channels::media::IMAGE_LIMIT,"audioBytes":attachment::AUDIO_LIMIT},
        "usage":"凭 recentMessages 回答并尽快回传：可附 text 和/或一个附件（image/audio 二选一），跳过提交 {requestKey,skip:true}；主动发信每次选文字、图或音。"
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
    operations["inboxUsage"] =
        json!("独立 GET ?wait=25（HTTP 超时 ≥40s），空结果立即续接；inboxWaitSeconds=0 时等 2s。");
    Ok(Json(
        json!({"ok":true,"items":items,"serverNow":crate::host::now_ms(),"operations":operations}),
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

async fn reply(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    body: std::result::Result<Json<ReplyBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let _admission = app.host.admit_owned()?;
    submit_reply(&app, &mailbox, body.map_err(invalid_message_body)?.0).await
}
