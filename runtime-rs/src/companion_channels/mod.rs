mod configuration;
mod conversation;
mod media;
mod pairing;
mod qq;
mod secret;
mod state_files;
mod types;
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

use pairing::{is_current, pair};
use state_files::{read, read_bot, read_bot_by_app_id, read_bots, state_path, write, write_bots};
use types::*;

fn message_tag(id: &str) -> String {
    let mut digest = crate::storage::json_fingerprint(&json!(id));
    digest.truncate(12);
    digest
}

#[derive(Default)]
pub(crate) struct Channels {
    updates: Notify,
    write: tokio::sync::Mutex<()>,
    connections: Mutex<HashMap<String, Connection>>,
    pairs: Mutex<HashMap<(String, QqPairKind), Pairing>>,
    qq_bindings: Mutex<HashMap<String, std::sync::Weak<qq::BindingUpdates>>>,
    muse_qq: Mutex<Option<std::sync::Arc<qq::muse::Mailbox>>>,
    wechat_turn: tokio::sync::Mutex<()>,
    wechat_cancel: Mutex<CancellationToken>,
}

impl Channels {
    fn close_muse_qq(&self) {
        if let Some(mailbox) = self.muse_qq.lock().unwrap().take() {
            mailbox.close();
        }
    }

    fn set_pair(&self, bot_id: &str, kind: QqPairKind, pairing: Pairing) {
        self.pairs
            .lock()
            .unwrap()
            .insert((bot_id.to_owned(), kind), pairing);
    }

    fn clear_pairs(&self, bot_id: &str) {
        self.pairs.lock().unwrap().retain(|(id, _), _| id != bot_id);
    }

    fn pair_code(
        &self,
        storage: &Storage,
        bot_id: &str,
        kind: QqPairKind,
    ) -> (Option<String>, Option<u64>) {
        let pairs = self.pairs.lock().unwrap();
        let pair = pairs
            .get(&(bot_id.to_owned(), kind))
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
        self.qq_bindings.lock().unwrap().remove(bot_id);
    }

    fn update_qq_bindings(&self, settings: &Settings) {
        let bindings = self
            .qq_bindings
            .lock()
            .unwrap()
            .get(&settings.id)
            .and_then(std::sync::Weak::upgrade);
        if let Some(bindings) = bindings {
            bindings.send_replace(qq::Bindings::from_settings(settings));
        }
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
