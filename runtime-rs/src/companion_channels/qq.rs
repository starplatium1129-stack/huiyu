mod ambient;
mod api;
mod events;
mod gateway;
mod inbox;
mod members;
pub(super) mod muse;
mod quotes;
mod replies;

use super::{
    conversation::{
        Context, Conversation, DeliveryIssue, Incoming, Reply, batch_message, is_command,
    },
    *,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use events::{event_message_id, message_tag, muse_sender_id, open_id};
use futures_util::StreamExt;
use inbox::process;
use reqwest::Client;
use std::{
    borrow::Cow,
    collections::HashMap,
    sync::{Arc, RwLock},
};
use tokio::sync::{Mutex as AsyncMutex, mpsc};
use tokio::time::Instant;

const API: &str = "https://api.bot.qq.com";
const CONNECTION_ERROR: &str = "QQ 连接中断，正在自动重连";

struct Api {
    client: Client,
    app_id: String,
    secret: String,
    token: AsyncMutex<Option<(String, Instant)>>,
    quotes: quotes::SentQuotes,
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
    quoted: Option<String>,
    images: Vec<Value>,
}

struct Inboxes {
    private_muse: bool,
    group_muse: bool,
    group_muse_all: bool,
    ambient: Option<Arc<ambient::GroupChat>>,
    bindings: Arc<RwLock<Bindings>>,
    direct: mpsc::Sender<Message>,
    groups: mpsc::Sender<Message>,
    muse: mpsc::Sender<Message>,
}

struct Bindings {
    owner: Option<String>,
    groups: Vec<QqGroup>,
}

impl Bindings {
    fn allows(&self, target: Destination<'_>) -> bool {
        is_bound(self.owner.as_deref(), &self.groups, target)
    }
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
            &settings.id,
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
        app.channels.report(
            &storage,
            &settings.id,
            "error",
            Some("QQ 网络连接初始化失败"),
        );
        return;
    };
    let voice_profile: String = match settings.voice_profile.as_str() {
        "auto" | "" => {
            if settings.character == "natsume" {
                "natsume".into()
            } else if settings.character == "nene" {
                "nene".into()
            } else if let Some(catalog_id) =
                crate::chat::chat_card_catalog_id(&app, &settings.character).await
            {
                if catalog_id == "natsume" {
                    "natsume".into()
                } else if let Some(resolved) = app
                    .voice
                    .as_ref()
                    .and_then(|voice| voice.resolve_catalog_voice(&catalog_id))
                {
                    resolved
                } else {
                    "nene".into()
                }
            } else {
                "nene".into()
            }
        }
        explicit if crate::voice::is_valid_voice_id(explicit) => explicit.to_owned(),
        _ => "nene".into(),
    };
    let api = Arc::new(Api {
        client,
        app_id: settings.app_id.clone(),
        secret,
        token: AsyncMutex::new(None),
        quotes: quotes::SentQuotes::default(),
    });
    let (direct_sender, direct) = mpsc::channel(16);
    let (group_sender, groups) = mpsc::channel(16);
    let (muse_sender, muse_inbox) = mpsc::channel(16);
    let ambient = (settings.group_natural_replies && !settings.group_muse)
        .then(|| Arc::new(ambient::GroupChat::default()));
    let inboxes = Inboxes {
        private_muse: settings.private_muse,
        group_muse: settings.group_muse,
        group_muse_all: settings.group_muse_all,
        ambient: ambient.clone(),
        bindings: Arc::new(RwLock::new(Bindings {
            owner: settings.owner.clone(),
            groups: settings.groups.clone(),
        })),
        direct: direct_sender,
        groups: group_sender,
        muse: muse_sender.clone(),
    };
    if settings.uses_muse() {
        let _lock = app.channels.write.lock().await;
        if read_bot(&app, &storage, &principal, &settings.id)
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
    let bot_id = settings.id.clone();
    let uses_muse = settings.uses_muse();
    let worker_cancel = cancel.clone();
    let worker_app = app.clone();
    let worker_storage = storage.clone();
    let worker_api = api.clone();
    let bindings = inboxes.bindings.clone();
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
                async {
                    if let Some(activity) = ambient.as_deref() {
                        activity.run(
                            &worker_app, &worker_storage, &settings, &bindings, &worker_api, &worker_cancel,
                        ).await;
                    }
                },
                process(
                    &worker_app,
                    &worker_storage,
                    &principal,
                    settings.clone(),
                    &voice_profile,
                    &worker_api,
                    &worker_cancel,
                    QqScope::Private,
                    &bindings,
                    &muse_sender,
                    direct
                ),
                process(
                    &worker_app,
                    &worker_storage,
                    &principal,
                    settings.clone(),
                    &voice_profile,
                    &worker_api,
                    &worker_cancel,
                    QqScope::Group,
                    &bindings,
                    &muse_sender,
                    groups
                ),
            );
        };
        tokio::select! { _ = worker_cancel.cancelled() => {}, _ = handle => {} }
    });
    let gateway_processes = Arc::new(crate::processes::Processes::default());
    let mut resume = gateway::Resume::default();
    let mut delay = 1;
    while !cancel.is_cancelled() && is_current(&app, &storage) {
        app.channels.report(&storage, &bot_id, "connecting", None);
        let result = gateway::connect(
            &app, &storage, &bot_id, &api, &inboxes, &mut resume, &gateway_processes, &cancel,
        )
        .await;
        if cancel.is_cancelled() {
            break;
        }
        let detail = match result {
            Err(error) => error,
            Ok(()) => CONNECTION_ERROR,
        };
        app.channels
            .report(&storage, &bot_id, "error", Some(detail));
        if std::mem::take(&mut resume.connected) {
            delay = 1;
        }
        if delay == 1 {
            eprintln!("QQ WebSocket 等待重连：{detail}");
        }
        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
        delay = (delay * 2).min(30);
    }
    gateway_processes.close().await;
    cancel.cancel();
    let _ = worker.await;
    if uses_muse {
        app.channels.close_muse_qq();
    }
}

fn allows(settings: &Settings, target: Destination<'_>) -> bool {
    is_bound(settings.owner.as_deref(), &settings.groups, target)
}

fn is_bound(owner: Option<&str>, groups: &[QqGroup], target: Destination<'_>) -> bool {
    match target.scope {
        QqScope::Private => owner == Some(target.id),
        QqScope::Group => groups.iter().any(|group| group.id == target.id),
    }
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
