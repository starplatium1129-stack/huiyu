mod conversation;
mod media;
mod qq;
mod secret;
pub(crate) mod wechat;
pub(crate) use qq::muse::router as muse_qq_router;

use crate::{
    AppState,
    error::{ApiError, Result},
    host::Session,
    storage::Storage,
};
use axum::{body::Bytes, http::Method};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::Notify, task::JoinHandle};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct Channels {
    updates: Notify,
    write: tokio::sync::Mutex<()>,
    connection: Mutex<Connection>,
    pair: Mutex<Option<Pairing>>,
    group_pair: Mutex<Option<Pairing>>,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum QqScope {
    Private,
    Group,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct QqGroup {
    id: String,
    label: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    app_id: String,
    sealed_secret: String,
    character: String,
    enabled: bool,
    drawing: bool,
    owner: Option<String>,
    #[serde(default)]
    group_drawing: bool,
    #[serde(default)]
    group_muse: bool,
    #[serde(default)]
    private_muse: bool,
    #[serde(default)]
    group_muse_all: bool,
    #[serde(default)]
    muse_proactive: bool,
    #[serde(default)]
    groups: Vec<QqGroup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    app_id: String,
    secret: Option<String>,
    character: String,
    enabled: bool,
    drawing: bool,
    group_drawing: Option<bool>,
    group_muse: Option<bool>,
    private_muse: Option<bool>,
    group_muse_all: Option<bool>,
    muse_proactive: Option<bool>,
}

impl Settings {
    fn muse_for(&self, scope: QqScope) -> bool {
        match scope {
            QqScope::Private => self.private_muse,
            QqScope::Group => self.group_muse,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupPairRequest {
    label: String,
}

pub(crate) async fn configure(
    app: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    path: &[String],
    body: Bytes,
) -> Result<Value> {
    let principal = principal(app)
        .filter(|value| value == &session.principal_id)
        .ok_or_else(|| ApiError::new(403, "LOCAL_ONLY", "请在绘遇桌面客户端设置手机聊天"))?;
    if body.len() > 4096 {
        return Err(ApiError::invalid("连接设置过长"));
    }
    if path.first().is_some_and(|channel| channel == "wechat") {
        return wechat::configure(app, storage, &principal, method, &path[1..], &body).await;
    }
    let file = settings_path(app, storage, &principal);
    let _lock = app.channels.write.lock().await;
    let saved: Option<Settings> = read(&file).await?;
    match (method.as_str(), path) {
        ("GET" | "HEAD", [channel]) if channel == "qq" => Ok(status(app, storage, saved.as_ref())),
        ("PUT", [channel]) if channel == "qq" => {
            let _admission = app.host.admit()?;
            let change: Change = serde_json::from_slice(&body)?;
            let same = saved.as_ref().filter(|old| old.app_id == change.app_id);
            if !(1..=24).contains(&change.app_id.len())
                || !change.app_id.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(ApiError::invalid("QQ AppID 必须为数字"));
            }
            let sealed_secret = match change.secret.filter(|value| !value.is_empty()) {
                Some(secret)
                    if (8..=512).contains(&secret.len())
                        && secret.bytes().all(|byte| byte.is_ascii_graphic()) =>
                {
                    secret::seal(&secret)?
                }
                Some(_) => return Err(ApiError::invalid("请检查 QQ 机器人 AppSecret")),
                None => same
                    .map(|old| old.sealed_secret.clone())
                    .ok_or_else(|| ApiError::invalid("请输入 QQ 机器人 AppSecret"))?,
            };
            if !matches!(change.character.as_str(), "nene" | "natsume") {
                return Err(ApiError::invalid("请选择陪伴角色"));
            }
            let settings = Settings {
                app_id: change.app_id,
                sealed_secret,
                character: change.character,
                enabled: change.enabled,
                drawing: change.drawing,
                owner: same.and_then(|old| old.owner.clone()),
                group_drawing: change
                    .group_drawing
                    .unwrap_or_else(|| same.is_some_and(|old| old.group_drawing)),
                group_muse: change
                    .group_muse
                    .unwrap_or_else(|| same.is_some_and(|old| old.group_muse)),
                private_muse: change
                    .private_muse
                    .unwrap_or_else(|| same.is_some_and(|old| old.private_muse)),
                group_muse_all: change
                    .group_muse_all
                    .unwrap_or_else(|| same.is_some_and(|old| old.group_muse_all)),
                muse_proactive: change
                    .muse_proactive
                    .unwrap_or_else(|| same.is_some_and(|old| old.muse_proactive)),
                groups: same.map(|old| old.groups.clone()).unwrap_or_default(),
            };
            write(&file, &settings).await?;
            app.channels.close_muse_qq();
            *app.channels.pair.lock().unwrap() = None;
            *app.channels.group_pair.lock().unwrap() = None;
            app.channels.report(
                storage,
                if settings.enabled {
                    "connecting"
                } else {
                    "disabled"
                },
                None,
            );
            app.channels.updates.notify_one();
            Ok(status(app, storage, Some(&settings)))
        }
        ("POST", [channel, action])
            if channel == "qq" && matches!(action.as_str(), "pair" | "pair-group") =>
        {
            let settings = saved
                .filter(|value| value.enabled)
                .ok_or_else(|| ApiError::invalid("请先保存并启用 QQ 连接"))?;
            let _admission = app.host.admit()?;
            let (scope, label) = if action == "pair-group" {
                let request: GroupPairRequest = serde_json::from_slice(&body)?;
                let label = request.label.trim();
                if label.chars().count() > 40 || label.chars().any(char::is_control) {
                    return Err(ApiError::invalid("群备注最多 40 字，请使用普通文字"));
                }
                (QqScope::Group, label.to_owned())
            } else {
                (QqScope::Private, String::new())
            };
            let code = uuid::Uuid::new_v4().simple().to_string()[..12].to_owned();
            *app.channels.pairing(scope).lock().unwrap() = Some(Pairing {
                epoch: storage.runtime_epoch().into(),
                code,
                expires_at: crate::host::now_ms() + 5 * 60_000,
                label,
            });
            Ok(status(app, storage, Some(&settings)))
        }
        ("DELETE", [channel, resource, id]) if channel == "qq" && resource == "groups" => {
            let mut settings = saved.ok_or_else(|| ApiError::invalid("QQ 连接还没有配置"))?;
            let _admission = app.host.admit()?;
            let previous = settings.groups.len();
            settings.groups.retain(|group| group.id != *id);
            if settings.groups.len() != previous {
                write(&file, &settings).await?;
                app.channels.close_muse_qq();
                app.channels.updates.notify_one();
            }
            Ok(status(app, storage, Some(&settings)))
        }
        _ => Err(ApiError::new(404, "CHANNEL_ROUTE", "找不到消息连接选项")),
    }
}

fn status(app: &AppState, storage: &Storage, settings: Option<&Settings>) -> Value {
    let connection = app.channels.connection.lock().unwrap();
    let current = connection.epoch == storage.runtime_epoch() && !connection.phase.is_empty();
    let enabled = settings.is_some_and(|value| value.enabled);
    let (pair_code, pair_expires) = app.channels.pair_code(storage, QqScope::Private);
    let (group_code, group_expires) = app.channels.pair_code(storage, QqScope::Group);
    let muse_status =
        if !enabled || !settings.is_some_and(|value| value.group_muse || value.private_muse) {
            None
        } else {
            Some(
                app.channels
                    .muse_qq
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map_or("waiting", |m| m.status(storage)),
            )
        };
    json!({"ok":true,"configured":settings.is_some(),"enabled":enabled,
        "appId":settings.map(|value| &value.app_id),"character":settings.map_or("nene", |value| &value.character),
        "drawing":settings.is_some_and(|value| value.drawing),"paired":settings.is_some_and(|value| value.owner.is_some()),
        "groupDrawing":settings.is_some_and(|value| value.group_drawing),"groupMuse":settings.is_some_and(|value| value.group_muse),
        "privateMuse":settings.is_some_and(|value| value.private_muse),
        "groupMuseAll":settings.is_some_and(|value| value.group_muse_all),
        "museProactive":settings.is_some_and(|value| value.muse_proactive),
        "groupMuseStatus":muse_status,"groups":settings.map_or(&[][..], |value| value.groups.as_slice()),
        "phase":if !enabled { "disabled" } else if current { connection.phase } else { "connecting" },
        "detail":if enabled && current { connection.detail } else { None },
        "pairCode":pair_code,"pairExpiresAt":pair_expires,
        "groupPairCode":group_code,"groupPairExpiresAt":group_expires})
}

impl Channels {
    fn close_muse_qq(&self) {
        if let Some(mailbox) = self.muse_qq.lock().unwrap().take() {
            mailbox.close();
        }
    }

    fn pairing(&self, scope: QqScope) -> &Mutex<Option<Pairing>> {
        match scope {
            QqScope::Private => &self.pair,
            QqScope::Group => &self.group_pair,
        }
    }

    fn pair_code(&self, storage: &Storage, scope: QqScope) -> (Option<String>, Option<u64>) {
        let pair = self.pairing(scope).lock().unwrap();
        let pair = pair.as_ref().filter(|pair| pair.is_current(storage));
        (
            pair.map(|pair| pair.code.clone()),
            pair.map(|pair| pair.expires_at),
        )
    }

    fn report(&self, storage: &Storage, phase: &'static str, detail: Option<&'static str>) {
        *self.connection.lock().unwrap() = Connection {
            epoch: storage.runtime_epoch().into(),
            phase,
            detail,
        };
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
    let mut running: Option<(CancellationToken, JoinHandle<()>)> = None;
    let mut epoch = String::new();
    let mut changed = true;
    loop {
        let storage = app
            .host
            .storage()
            .filter(|_| app.host.check_available().is_ok());
        let current = storage.as_ref().map_or("", Storage::runtime_epoch);
        if changed || current != epoch {
            if let Some((token, worker)) = running.take() {
                token.cancel();
                let _ = worker.await;
            }
            epoch = current.into();
            changed = false;
            if let Some(storage) = storage {
                match read::<Settings>(&settings_path(&app, &storage, &principal)).await {
                    Ok(Some(settings)) if settings.enabled => {
                        let token = app.shutdown.child_token();
                        let worker = tokio::spawn(qq::run(
                            app.clone(),
                            storage,
                            principal.clone(),
                            settings,
                            token.clone(),
                        ));
                        running = Some((token, worker));
                    }
                    Err(_) => app
                        .channels
                        .report(&storage, "error", Some("无法读取 QQ 连接设置")),
                    _ => {}
                }
            }
        }
        tokio::select! {
            _ = app.shutdown.cancelled() => break,
            _ = app.channels.updates.notified() => changed = true,
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
    }
    if let Some((token, worker)) = running {
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

fn settings_path(app: &AppState, storage: &Storage, principal: &str) -> PathBuf {
    state_path(app, storage, principal, &json!(["qq", "settings"]))
}

fn state_path(app: &AppState, storage: &Storage, principal: &str, slot: &Value) -> PathBuf {
    let key = crate::storage::json_fingerprint(&json!([storage.workspace_id(), principal, slot]));
    app.config
        .runtime_root
        .join("state/companion-channels")
        .join(format!("{key}.json"))
}

async fn read<T: DeserializeOwned>(file: &Path) -> Result<Option<T>> {
    match tokio::fs::read(file).await {
        Ok(data) => serde_json::from_slice(&data)
            .map(Some)
            .map_err(|_| ApiError::invalid("本机消息连接记录无法读取")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn write<T: Serialize>(file: &Path, value: &T) -> Result<()> {
    let parent = file.parent().expect("channel state directory");
    tokio::fs::create_dir_all(parent).await?;
    let (output, pending) = tempfile::NamedTempFile::new_in(parent)?.into_parts();
    let mut output = tokio::fs::File::from_std(output);
    output.write_all(&serde_json::to_vec(value)?).await?;
    output.sync_all().await?;
    drop(output);
    pending.persist(file).map_err(|error| error.error)?;
    Ok(())
}

async fn pair(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    app_id: &str,
    scope: QqScope,
    target: &str,
    code: &str,
) -> Result<Option<Settings>> {
    let _lock = app.channels.write.lock().await;
    if !is_current(app, storage) {
        return Ok(None);
    }
    let slot = app.channels.pairing(scope);
    let label = slot
        .lock()
        .unwrap()
        .as_ref()
        .filter(|pair| pair.is_current(storage) && pair.code == code)
        .map(|pair| pair.label.clone());
    let Some(label) = label else { return Ok(None) };
    let path = settings_path(app, storage, principal);
    let Some(mut settings) = read::<Settings>(&path)
        .await?
        .filter(|settings| settings.enabled && settings.app_id == app_id)
    else {
        return Ok(None);
    };
    let replaced_owner = scope == QqScope::Private
        && settings.private_muse
        && settings.owner.as_deref().is_some_and(|old| old != target);
    match scope {
        QqScope::Private => settings.owner = Some(target.into()),
        QqScope::Group => {
            if let Some(group) = settings.groups.iter_mut().find(|group| group.id == target) {
                if !label.is_empty() {
                    group.label = label;
                }
            } else {
                let tail = &target[target.len().saturating_sub(6)..];
                settings.groups.push(QqGroup {
                    id: target.into(),
                    label: if label.is_empty() {
                        format!("QQ群 · {tail}")
                    } else {
                        label
                    },
                });
            }
        }
    }
    let _admission = app.host.admit()?;
    write(&path, &settings).await?;
    if replaced_owner {
        app.channels.close_muse_qq();
        app.channels.updates.notify_one();
    }
    *slot.lock().unwrap() = None;
    Ok(Some(settings))
}

fn is_current(app: &AppState, storage: &Storage) -> bool {
    app.host.check_available().is_ok()
        && app
            .host
            .storage()
            .is_some_and(|value| value.runtime_epoch() == storage.runtime_epoch())
}
