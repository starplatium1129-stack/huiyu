use super::super::*;
use crate::file_identity::Version;
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    net::SocketAddr,
    path::Path,
    sync::Mutex,
};

pub(super) const PATH: &str = "/api/muse/inputs/lookup";

#[derive(Clone)]
struct Entry {
    owner: String,
    digest: String,
    name: String,
    version: Version,
}

pub(in crate::images) struct UploadIndex {
    root: PathBuf,
    entries: Mutex<VecDeque<Entry>>,
    limit: generation::RateLimit,
}

fn version(path: &Path) -> Option<Version> {
    if !path.symlink_metadata().ok()?.file_type().is_file() {
        return None;
    }
    Version::of(&File::open(path).ok()?).ok()
}

impl UploadIndex {
    pub(super) fn new(root: PathBuf) -> Self {
        Self {
            root,
            entries: Mutex::default(),
            limit: generation::RateLimit::with("素材复用查询", 30, 500),
        }
    }

    pub(in crate::images) fn has_uploads(&self) -> bool {
        !self.entries.lock().unwrap().is_empty()
    }

    pub(in crate::images) async fn remember(
        self: Arc<Self>,
        owner: String,
        name: String,
        bytes: Bytes,
        cancel: CancellationToken,
    ) {
        // Register only bytes accepted by the normal upload/ownership path.
        // The caller retains its upload permit until this worker releases the body.
        let _ = tokio::task::spawn_blocking(move || {
            let mut hash = Sha256::new();
            for chunk in bytes.chunks(1024 * 1024) {
                if cancel.is_cancelled() {
                    return;
                }
                hash.update(chunk);
            }
            let Some(version) = version(&self.root.join(&name)) else {
                return;
            };
            let digest = hex::encode(hash.finalize());
            let mut entries = self.entries.lock().unwrap();
            entries.retain(|e| e.owner != owner || e.digest != digest);
            if entries.len() >= 256 {
                entries.pop_front();
            }
            entries.push_back(Entry {
                owner,
                digest,
                name,
                version,
            });
        })
        .await;
    }

    fn lookup(&self, owner: &str, hashes: &[String]) -> HashMap<String, String> {
        let candidates: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.owner == owner && hashes.contains(&e.digest))
            .cloned()
            .collect();
        candidates
            .into_iter()
            .filter(|e| version(&self.root.join(&e.name)).as_ref() == Some(&e.version))
            .map(|e| (e.digest, e.name))
            .collect()
    }
}

pub(super) fn router() -> Router<crate::AppState> {
    Router::new().route(PATH, post(lookup).layer(DefaultBodyLimit::max(2048)))
}

async fn lookup(
    State(state): State<crate::AppState>,
    Extension(index): Extension<Arc<UploadIndex>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(hashes): Json<Vec<String>>,
) -> Response {
    if let Some(response) = index.limit.check(false) {
        return response;
    }
    http::response(
        async {
            state.host.check_running()?;
            if hashes.len() > 16
                || hashes
                    .iter()
                    .any(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                return Err(ApiError::invalid("每次最多查询 16 个 SHA-256 素材摘要"));
            }
            let owner = generation::request_owner(&headers, peer, &HashMap::new());
            let found = tokio::task::spawn_blocking(move || index.lookup(&owner, &hashes))
                .await
                .map_err(|_| closed())?;
            Ok(json!({"inputs":found}))
        }
        .await,
        StatusCode::OK,
    )
}
