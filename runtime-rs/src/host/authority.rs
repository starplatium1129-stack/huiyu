use crate::{
    AppState,
    error::{ApiError, Result},
    security::{host_allowed, is_direct_local},
    storage::Storage,
};
use axum::http::{HeaderMap, Method};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Notify;
use url::Url;
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub workspace_id: String,
    pub runtime_epoch: String,
    pub principal_id: String,
    pub scopes: Vec<String>,
    pub origin: String,
    pub expires_at: u64,
    pub token: String,
}

#[derive(Clone)]
pub(crate) struct MediaGrant {
    pub alias: String,
    pub session: Session,
    pub expires_at: u64,
}

#[derive(Default)]
struct AuthorityState {
    storage: Option<Storage>,
    active: Option<Value>,
    candidate: Option<Value>,
    nonces: HashMap<String, u64>,
    sessions: HashMap<String, Session>,
    media: HashMap<String, MediaGrant>,
    draining: bool,
    maintenance: bool,
    pending: usize,
}

#[derive(Default)]
pub struct HostAuthority {
    state: Mutex<AuthorityState>,
    drained: Notify,
    closing: tokio_util::task::TaskTracker,
    pub(crate) operation: tokio::sync::Mutex<()>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn token() -> String {
    // UUID v4 uses the OS CSPRNG. Three UUIDs supply more than 256 random bits.
    let mut hash = Sha256::new();
    for _ in 0..3 {
        hash.update(Uuid::new_v4().as_bytes());
    }
    URL_SAFE_NO_PAD.encode(hash.finalize())
}

pub(crate) fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

impl HostAuthority {
    pub fn new(storage: Option<Storage>, active: Option<Value>, candidate: Option<Value>) -> Self {
        Self {
            state: Mutex::new(AuthorityState {
                storage,
                active,
                candidate,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    pub fn storage(&self) -> Option<Storage> {
        self.state.lock().unwrap().storage.clone()
    }

    pub(crate) fn active(&self) -> Option<Value> {
        self.state.lock().unwrap().active.clone()
    }

    pub(crate) fn selected(&self) -> Option<Value> {
        let state = self.state.lock().unwrap();
        state.active.as_ref().or(state.candidate.as_ref()).cloned()
    }

    pub(crate) fn install(&self, storage: Storage, pointer: Value, candidate: bool) {
        let mut state = self.state.lock().unwrap();
        if state.storage.as_ref().is_none_or(|previous| {
            previous.workspace_id() != storage.workspace_id()
                || previous.runtime_epoch() != storage.runtime_epoch()
        }) {
            state.sessions.clear();
            state.media.clear();
        }
        state.storage = Some(storage);
        if candidate {
            state.candidate = Some(pointer);
        } else {
            state.active = Some(pointer);
        }
    }

    pub(crate) fn retire(&self, storage: Storage) -> tokio::task::JoinHandle<Result<()>> {
        self.closing.spawn(async move { storage.close().await })
    }
    pub(crate) fn maintenance(&self) -> Result<MaintenanceGuard<'_>> {
        let mut state = self.state.lock().unwrap();
        if state.draining {
            return Err(draining());
        }
        if state.maintenance {
            return Err(ApiError::new(
                409,
                "WORKSPACE_BUSY",
                "Another host operation is in progress",
            ));
        }
        state.maintenance = true;
        Ok(MaintenanceGuard(self))
    }

    pub(crate) fn check_available(&self) -> Result<()> {
        let state = self.state.lock().unwrap();
        if state.draining {
            return Err(draining());
        }
        if state.maintenance {
            return Err(ApiError::new(
                503,
                "WORKSPACE_MAINTENANCE",
                "Workspace is under maintenance",
            ));
        }
        Ok(())
    }

    pub(crate) fn verify(
        &self,
        secret: &str,
        headers: &HeaderMap,
        peer: IpAddr,
        body: &[u8],
        input: &Value,
    ) -> bool {
        let is_hex = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        };
        let Some(timestamp) = input["timestamp"].as_u64() else {
            return false;
        };
        let Some(nonce) = input["nonce"].as_str() else {
            return false;
        };
        let Some(proof) = header(headers, "x-aics-host-proof") else {
            return false;
        };
        let now = now_ms();
        if !is_hex(secret)
            || !is_hex(nonce)
            || !is_hex(proof)
            || timestamp.abs_diff(now) > 30_000
            || !is_direct_local(headers, peer)
            || !host_allowed(header(headers, "host").unwrap_or(""))
            || headers.contains_key("origin")
            || headers.contains_key("sec-fetch-site")
        {
            return false;
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .expect("HMAC accepts all key lengths");
        mac.update(b"aics-desktop-host:v1\n");
        mac.update(body);
        if mac
            .verify_slice(&hex::decode(proof).unwrap_or_default())
            .is_err()
        {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        state.nonces.retain(|_, expires| *expires >= now);
        if state.nonces.contains_key(nonce) {
            return false;
        }
        state.nonces.insert(nonce.to_owned(), timestamp + 30_000);
        true
    }

    pub(crate) fn origin_registered(&self, state: &AppState, origin: &str) -> bool {
        origin == state.config.gateway_origin
            || [
                "http://tauri.localhost",
                "https://tauri.localhost",
                "tauri://localhost",
                "https://huiyu.localhost",
            ]
            .contains(&origin)
    }

    fn request_origin(
        &self,
        state: &AppState,
        headers: &HeaderMap,
        method: &Method,
    ) -> Option<String> {
        if headers.contains_key("origin") {
            return header(headers, "origin")
                .filter(|origin| self.origin_registered(state, origin))
                .map(str::to_owned);
        }
        if !matches!(*method, Method::GET | Method::HEAD)
            || header(headers, "sec-fetch-site") != Some("same-origin")
        {
            return None;
        }
        let referer = Url::parse(header(headers, "referer")?).ok()?;
        let origin = referer.origin().ascii_serialization();
        let origin_host = &referer[url::Position::BeforeHost..url::Position::AfterPort];
        (matches!(referer.scheme(), "http" | "https")
            && referer.username().is_empty()
            && referer.password().is_none()
            && origin_host.eq_ignore_ascii_case(header(headers, "host")?)
            && self.origin_registered(state, &origin))
        .then_some(origin)
    }

    pub(crate) fn allows_origin(
        &self,
        state: &AppState,
        headers: &HeaderMap,
        peer: IpAddr,
        method: &Method,
    ) -> bool {
        !self.state.lock().unwrap().draining
            && is_direct_local(headers, peer)
            && host_allowed(header(headers, "host").unwrap_or(""))
            && self.request_origin(state, headers, method).is_some()
    }

    pub(crate) fn issue(
        &self,
        workspace: &str,
        epoch: &str,
        principal: &str,
        origin: &str,
        backup: bool,
    ) -> Result<Session> {
        let now = now_ms();
        let mut state = self.state.lock().unwrap();
        if state.draining {
            return Err(draining());
        }
        state.sessions.retain(|_, session| session.expires_at > now);
        let mut scopes = vec!["workspace:read".into(), "workspace:write".into()];
        if backup {
            scopes.push("workspace:backup".into());
        }
        let session = Session {
            workspace_id: workspace.into(),
            runtime_epoch: epoch.into(),
            principal_id: principal.into(),
            scopes,
            origin: origin.into(),
            expires_at: now + 15 * 60_000,
            token: token(),
        };
        state
            .sessions
            .insert(session.token.clone(), session.clone());
        Ok(session)
    }

    pub(crate) fn authenticate(
        &self,
        state: &AppState,
        headers: &HeaderMap,
        peer: IpAddr,
        method: &Method,
        scope: &str,
    ) -> Result<Session> {
        let denied = || {
            ApiError::new(
                401,
                "WORKSPACE_AUTH",
                "Workspace session is invalid or expired",
            )
        };
        if !self.allows_origin(state, headers, peer, method) {
            return Err(denied());
        }
        let token = header(headers, "x-aics-workspace-session").ok_or_else(denied)?;
        let origin = self
            .request_origin(state, headers, method)
            .ok_or_else(denied)?;
        let mut authority = self.state.lock().unwrap();
        let session = authority.sessions.get(token).ok_or_else(denied)?.clone();
        if session.expires_at <= now_ms() {
            authority.sessions.remove(token);
            return Err(denied());
        }
        let storage = authority.storage.as_ref().ok_or_else(denied)?;
        if session.origin != origin
            || !session.scopes.iter().any(|value| value == scope)
            || session.workspace_id != storage.workspace_id()
            || session.runtime_epoch != storage.runtime_epoch()
        {
            return Err(denied());
        }
        Ok(session)
    }

    pub(crate) fn grant_media(&self, alias: String, session: Session) -> Result<(String, u64)> {
        let now = now_ms();
        let mut state = self.state.lock().unwrap();
        if state.draining {
            return Err(draining());
        }
        state.media.retain(|_, grant| grant.expires_at > now);
        if state.media.len() >= 256 {
            return Err(ApiError::new(
                429,
                "MEDIA_BUSY",
                "Too many media capabilities",
            ));
        }
        let key = token();
        let expires_at = (now + 120_000).min(session.expires_at);
        state.media.insert(
            key.clone(),
            MediaGrant {
                alias,
                session,
                expires_at,
            },
        );
        Ok((key, expires_at))
    }

    pub(crate) fn media_grant(&self, key: &str) -> Option<MediaGrant> {
        let state = self.state.lock().unwrap();
        if state.draining {
            return None;
        }
        state
            .media
            .get(key)
            .filter(|grant| grant.expires_at > now_ms())
            .cloned()
    }

    pub fn check_running(&self) -> Result<()> {
        if self.state.lock().unwrap().draining {
            Err(draining())
        } else {
            Ok(())
        }
    }

    pub(crate) fn admit(&self) -> Result<WriteGuard<'_>> {
        self.begin_write()?;
        Ok(WriteGuard(self))
    }

    pub(crate) fn admit_owned(self: &Arc<Self>) -> Result<OwnedWriteGuard> {
        self.begin_write()?;
        Ok(OwnedWriteGuard(self.clone()))
    }

    fn begin_write(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.draining {
            return Err(draining());
        }
        if state.maintenance {
            return Err(ApiError::new(
                503,
                "WORKSPACE_MAINTENANCE",
                "Workspace is under maintenance",
            ));
        }
        state.pending += 1;
        Ok(())
    }

    fn finish_write(&self) {
        self.state.lock().unwrap().pending -= 1;
        self.drained.notify_waiters();
    }

    pub async fn drain(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.draining = true;
            state.sessions.clear();
            state.media.clear();
        }
        self.wait_for_writes().await;
        self.closing.close();
        self.closing.wait().await;
    }

    pub(crate) async fn wait_for_writes(&self) {
        loop {
            let notified = self.drained.notified();
            if self.state.lock().unwrap().pending == 0 {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) struct MaintenanceGuard<'a>(&'a HostAuthority);
impl Drop for MaintenanceGuard<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().maintenance = false;
    }
}

pub(crate) struct WriteGuard<'a>(&'a HostAuthority);
impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        self.0.finish_write();
    }
}
pub(crate) struct OwnedWriteGuard(Arc<HostAuthority>);
impl Drop for OwnedWriteGuard {
    fn drop(&mut self) {
        self.0.finish_write();
    }
}
fn draining() -> ApiError {
    ApiError::new(503, "DESKTOP_DRAINING", "Desktop is draining")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signature_binds_raw_body_and_rejects_replay_and_browser_requests() {
        let authority = HostAuthority::new(None, None, None);
        let secret = "ab".repeat(32);
        let payload = json!({"timestamp": now_ms(), "nonce": "cd".repeat(32)});
        let body = serde_json::to_vec(&payload).unwrap();
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(b"aics-desktop-host:v1\n");
        mac.update(&body);
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:3000".parse().unwrap());
        headers.insert(
            "x-aics-host-proof",
            hex::encode(mac.finalize().into_bytes()).parse().unwrap(),
        );
        let peer = "127.0.0.1".parse().unwrap();
        assert!(!authority.verify(&secret, &headers, peer, b"{}", &payload));
        headers.insert("origin", "http://127.0.0.1:3000".parse().unwrap());
        assert!(!authority.verify(&secret, &headers, peer, &body, &payload));
        headers.remove("origin");
        assert!(authority.verify(&secret, &headers, peer, &body, &payload));
        assert!(!authority.verify(&secret, &headers, peer, &body, &payload));
    }

    #[tokio::test]
    async fn shutdown_waits_for_admitted_writes() {
        let authority = std::sync::Arc::new(HostAuthority::new(None, None, None));
        let guard = authority.admit().unwrap();
        let other = authority.clone();
        let draining = tokio::spawn(async move { other.drain().await });
        tokio::task::yield_now().await;
        assert!(authority.admit().is_err());
        assert!(!draining.is_finished());
        drop(guard);
        draining.await.unwrap();
    }
}
