mod configuration;
mod conversation;
mod media;
mod qq;
mod secret;
mod state_files;
pub(crate) use configuration::configure;
pub(crate) mod wechat;
pub(crate) use qq::muse::router as muse_qq_router;
pub(crate) use qq::muse::{
    configured_peer as muse_vm_peer, tailnet_router as muse_qq_tailnet_router,
};

use crate::{
    AppState,
    error::{ApiError, Result},
    host::Session,
    storage::Storage,
};
use axum::{body::Bytes, http::Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tokio::{sync::Notify, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use state_files::{read, read_bot, read_bot_by_app_id, read_bots, state_path, write, write_bots};

#[derive(Default)]
pub(crate) struct Channels {
    updates: Notify,
    write: tokio::sync::Mutex<()>,
    connections: Mutex<HashMap<String, Connection>>,
    pairs: Mutex<HashMap<(String, QqScope), Pairing>>,
    muse_qq: Mutex<Option<std::sync::Arc<qq::muse::Mailbox>>>,
    wechat_turn: tokio::sync::Mutex<()>,
    wechat_cancel: Mutex<CancellationToken>,
}

#[derive(Default)]
struct Connection {
    epoch: String,
    phase: &'static str,
    detail: Option<&'static str>,
}

struct Pairing {
    epoch: String,
    code: String,
    expires_at: u64,
    label: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum QqScope {
    Private,
    Group,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum QqChatProvider {
    #[default]
    Default,
    Chatgpt,
    ChatgptPrivate,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum QqVoiceMode {
    #[default]
    Off,
    OnDemand,
    Auto,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum QqOwnerBond {
    #[default]
    Default,
    Close,
    Intimate,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QqGroup {
    id: String,
    label: String,
    #[serde(default)]
    owner_member_id: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default = "default_bot_id")]
    id: String,
    #[serde(default)]
    name: String,
    app_id: String,
    sealed_secret: String,
    character: String,
    #[serde(default)]
    chat_provider: QqChatProvider,
    #[serde(default)]
    owner_bond: QqOwnerBond,
    #[serde(default)]
    owner_call_name: String,
    #[serde(default)]
    owner_note: String,
    #[serde(default)]
    voice_mode: QqVoiceMode,
    #[serde(default)]
    group_voice: bool,
    #[serde(default = "default_voice_profile")]
    voice_profile: String,
    enabled: bool,
    drawing: bool,
    owner: Option<String>,
    #[serde(default)]
    group_drawing: bool,
    #[serde(default)]
    group_natural_replies: bool,
    #[serde(default)]
    group_muse: bool,
    #[serde(default)]
    private_muse: bool,
    #[serde(default)]
    group_muse_all: bool,
    #[serde(default = "default_muse_context_limit")]
    muse_context_limit: usize,
    #[serde(default)]
    muse_proactive: bool,
    // Ordinary restarts keep the same history. A new binding/settings session starts fresh.
    #[serde(default)]
    muse_history_generation: String,
    #[serde(default)]
    groups: Vec<QqGroup>,
}

fn default_bot_id() -> String {
    "default".into()
}

fn default_voice_profile() -> String {
    "auto".into()
}

fn default_muse_context_limit() -> usize {
    32
}

impl Settings {
    // Context depth is read at intake. It does not change the active QQ connection.
    fn same_connection(&self, other: &Self) -> bool {
        let mut comparable = self.clone();
        comparable.muse_context_limit = other.muse_context_limit;
        comparable == *other
    }

    fn muse_for(&self, scope: QqScope) -> bool {
        match scope {
            QqScope::Private => self.private_muse,
            QqScope::Group => self.group_muse,
        }
    }

    fn uses_muse(&self) -> bool {
        self.private_muse || self.group_muse
    }

    fn chat_provider_for(&self, scope: QqScope) -> crate::chat::ChannelProvider {
        match (self.chat_provider, scope) {
            (QqChatProvider::Chatgpt, _) | (QqChatProvider::ChatgptPrivate, QqScope::Private) => {
                crate::chat::ChannelProvider::ChatGpt
            }
            _ => crate::chat::ChannelProvider::Default,
        }
    }

    fn owner_bond_kind(&self) -> crate::chat::ChannelOwnerBond {
        match self.owner_bond {
            QqOwnerBond::Default => crate::chat::ChannelOwnerBond::Default,
            QqOwnerBond::Close => crate::chat::ChannelOwnerBond::Close,
            QqOwnerBond::Intimate => crate::chat::ChannelOwnerBond::Intimate,
        }
    }

    fn voice_for(&self, scope: QqScope) -> (bool, bool) {
        let enabled = match scope {
            QqScope::Private => self.voice_mode != QqVoiceMode::Off,
            QqScope::Group => self.voice_mode != QqVoiceMode::Off && self.group_voice,
        };
        (enabled, enabled && self.voice_mode == QqVoiceMode::Auto)
    }
}

impl Channels {
    fn close_muse_qq(&self) {
        if let Some(mailbox) = self.muse_qq.lock().unwrap().take() {
            mailbox.close();
        }
    }

    fn set_pair(&self, bot_id: &str, scope: QqScope, pairing: Pairing) {
        self.pairs
            .lock()
            .unwrap()
            .insert((bot_id.to_owned(), scope), pairing);
    }

    fn clear_pairs(&self, bot_id: &str) {
        self.pairs.lock().unwrap().retain(|(id, _), _| id != bot_id);
    }

    fn pair_code(
        &self,
        storage: &Storage,
        bot_id: &str,
        scope: QqScope,
    ) -> (Option<String>, Option<u64>) {
        let pairs = self.pairs.lock().unwrap();
        let pair = pairs
            .get(&(bot_id.to_owned(), scope))
            .filter(|pair| pair.is_current(storage));
        (
            pair.map(|pair| pair.code.clone()),
            pair.map(|pair| pair.expires_at),
        )
    }

    fn report(
        &self,
        storage: &Storage,
        bot_id: &str,
        phase: &'static str,
        detail: Option<&'static str>,
    ) {
        self.connections.lock().unwrap().insert(
            bot_id.to_owned(),
            Connection {
                epoch: storage.runtime_epoch().into(),
                phase,
                detail,
            },
        );
    }

    fn remove_connection(&self, bot_id: &str) {
        self.connections.lock().unwrap().remove(bot_id);
    }
}

impl Pairing {
    fn is_current(&self, storage: &Storage) -> bool {
        self.epoch == storage.runtime_epoch() && self.expires_at > crate::host::now_ms()
    }
}

pub(crate) async fn run(app: AppState) {
    let Some(principal) = principal(&app) else {
        return;
    };
    let mut running: HashMap<String, (Settings, CancellationToken, JoinHandle<()>)> =
        HashMap::new();
    let mut epoch = String::new();
    let mut changed = true;
    loop {
        let storage = app
            .host
            .storage()
            .filter(|_| app.host.check_available().is_ok());
        let current = storage.as_ref().map_or("", Storage::runtime_epoch);
        if current != epoch {
            for (_, (_, token, worker)) in running.drain() {
                token.cancel();
                let _ = worker.await;
            }
            epoch = current.into();
            changed = true;
        }
        if changed {
            changed = false;
            if let Some(storage) = storage {
                match read_bots(&app, &storage, &principal).await {
                    Ok(bots) => {
                        let desired: HashMap<String, Settings> = bots
                            .into_iter()
                            .filter(|bot| bot.enabled)
                            .map(|bot| (bot.id.clone(), bot))
                            .collect();
                        let stop_ids: Vec<String> = running
                            .iter()
                            .filter(|(id, (old, _, _))| {
                                desired
                                    .get(*id)
                                    .is_none_or(|next| !old.same_connection(next))
                            })
                            .map(|(id, _)| id.clone())
                            .collect();
                        for id in stop_ids {
                            if let Some((_, token, worker)) = running.remove(&id) {
                                token.cancel();
                                let _ = worker.await;
                            }
                        }
                        for (id, bot) in desired {
                            if running.contains_key(&id) {
                                continue;
                            }
                            let token = app.shutdown.child_token();
                            let worker = tokio::spawn(qq::run(
                                app.clone(),
                                storage.clone(),
                                principal.clone(),
                                bot.clone(),
                                token.clone(),
                            ));
                            running.insert(id, (bot, token, worker));
                        }
                    }
                    Err(_) => {
                        for (_, (_, token, worker)) in running.drain() {
                            token.cancel();
                            let _ = worker.await;
                        }
                        app.channels.report(
                            &storage,
                            "default",
                            "error",
                            Some("无法读取 QQ 连接设置"),
                        );
                    }
                }
            } else {
                for (_, (_, token, worker)) in running.drain() {
                    token.cancel();
                    let _ = worker.await;
                }
            }
        }
        tokio::select! {
            _ = app.shutdown.cancelled() => break,
            _ = app.channels.updates.notified() => changed = true,
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
    }
    for (_, (_, token, worker)) in running.drain() {
        token.cancel();
        let _ = worker.await;
    }
}

fn principal(app: &AppState) -> Option<String> {
    app.config
        .source_profile_id
        .as_ref()
        .map(|id| format!("desktop:{id}"))
}

#[allow(clippy::too_many_arguments)]
async fn pair(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    bot_id: &str,
    app_id: &str,
    scope: QqScope,
    target: &str,
    member_id: &str,
    code: &str,
) -> Result<Option<Settings>> {
    let _lock = app.channels.write.lock().await;
    if !is_current(app, storage) {
        return Ok(None);
    }
    let key = (bot_id.to_owned(), scope);
    let label = app
        .channels
        .pairs
        .lock()
        .unwrap()
        .get(&key)
        .filter(|pair| pair.is_current(storage) && pair.code == code)
        .map(|pair| pair.label.clone());
    let Some(label) = label else { return Ok(None) };
    let mut bots = read_bots(app, storage, principal).await?;
    let Some(index) = bots
        .iter()
        .position(|bot| bot.id == bot_id && bot.enabled && bot.app_id == app_id)
    else {
        return Ok(None);
    };
    let replaced_owner = scope == QqScope::Private
        && bots[index].private_muse
        && bots[index]
            .owner
            .as_deref()
            .is_some_and(|old| old != target);
    match scope {
        QqScope::Private => bots[index].owner = Some(target.into()),
        QqScope::Group => {
            if let Some(group) = bots[index]
                .groups
                .iter_mut()
                .find(|group| group.id == target)
            {
                if !label.is_empty() {
                    group.label = label;
                }
                group.owner_member_id = Some(member_id.into());
            } else {
                let tail = &target[target.len().saturating_sub(6)..];
                bots[index].groups.push(QqGroup {
                    id: target.into(),
                    label: if label.is_empty() {
                        format!("QQ群 · {tail}")
                    } else {
                        label
                    },
                    owner_member_id: Some(member_id.into()),
                });
            }
        }
    }
    let _admission = app.host.admit()?;
    write_bots(app, storage, principal, &bots).await?;
    if replaced_owner {
        app.channels.close_muse_qq();
        app.channels.updates.notify_one();
    }
    app.channels.pairs.lock().unwrap().remove(&key);
    Ok(bots.into_iter().nth(index))
}

fn is_current(app: &AppState, storage: &Storage) -> bool {
    app.host.check_available().is_ok()
        && app
            .host
            .storage()
            .is_some_and(|value| value.runtime_epoch() == storage.runtime_epoch())
}
