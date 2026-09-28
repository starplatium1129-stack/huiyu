mod assets;
mod io;
mod release;
mod shards;
pub(crate) use shards::source_products;

use crate::{AppState, error::ApiError, security};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use std::{
    env,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
};

type Result<T> = std::result::Result<T, ApiError>;
type ReaderState = Arc<Mutex<Option<Reader>>>;

fn unavailable() -> ApiError {
    ApiError::new(503, "REFERENCE_UNAVAILABLE", "参考档案暂不可用")
}
fn invalid_release() -> ApiError {
    ApiError::new(503, "REFERENCE_RELEASE_INVALID", "参考资源版本未通过校验")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/character-reference-profile/{id}", get(profile))
        .route("/api/character-reference-profile/{id}/", get(profile))
        .route("/data/character-reference-view.json", get(view))
        .route("/character-references/{*file}", get(assets::serve))
        .layer(Extension(Arc::new(Mutex::new(None::<Reader>))))
        .layer(Extension(Arc::new(tokio::sync::Semaphore::new(4))))
}

async fn profile(
    State(state): State<AppState>,
    Extension(readers): Extension<ReaderState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    respond(state, readers, peer, headers, Some(id)).await
}

async fn view(
    State(state): State<AppState>,
    Extension(readers): Extension<ReaderState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    respond(state, readers, peer, headers, None).await
}

async fn respond(
    state: AppState,
    readers: ReaderState,
    peer: SocketAddr,
    headers: HeaderMap,
    id: Option<String>,
) -> Response {
    let result = if !security::is_direct_local(&headers, peer.ip()) {
        Err(ApiError::new(
            403,
            "REFERENCE_LOCAL_ONLY",
            "该参考资源仅限本机使用",
        ))
    } else if id.as_ref().is_some_and(|id| !valid_id(id)) {
        Err(ApiError::new(400, "REFERENCE_ID", "角色 ID 无效"))
    } else {
        let root = state.config.content_root();
        let media = reference_root(&state.config.app_root);
        tokio::task::spawn_blocking(move || {
            let mut slot = readers.lock().map_err(|_| unavailable())?;
            let reader = slot.get_or_insert_with(|| Reader::new(root.clone(), media));
            reader.read(id.as_deref())
        })
        .await
        .unwrap_or_else(|_| Err(unavailable()))
    };
    let mut response = match result {
        Ok(Some(profile)) => Json(profile).into_response(),
        Ok(None) => (
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({"error":"角色参考档案尚未登记"})),
        )
            .into_response(),
        Err(error) => error.into_response(),
    };
    response
        .headers_mut()
        .insert("cache-control", "private, no-cache".parse().unwrap());
    response
}

fn absolute(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        env::current_dir().unwrap_or_default().join(path)
    }
}

pub(crate) fn reference_root(root: &FsPath) -> Option<PathBuf> {
    // An invalid explicit root is retained so initialization fails closed.
    if let Some(explicit) = env::var_os("AICS_CHARACTER_REF_ROOT").filter(|v| !v.is_empty()) {
        return Some(absolute(explicit.into()));
    }
    let sibling = root.parent().unwrap_or(root).join("AI");
    let workspace = env::var_os("AI_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .map(absolute)
        .unwrap_or_else(|| sibling.clone());
    let assets = env::var_os("AICS_ASSETS_ROOT")
        .map(PathBuf::from)
        .map(absolute)
        .unwrap_or_else(|| root.join("assets"));
    [
        workspace.join("CharacterReferences"),
        sibling.join("CharacterReferences"),
        assets.join("character-references"),
    ]
    .into_iter()
    .find(|p| p.is_dir())
}

struct Reader {
    app_root: PathBuf,
    reference_root: Option<PathBuf>,
    release: Option<release::Release>,
    blocked: bool,
}

impl Reader {
    fn new(app_root: PathBuf, reference_root: Option<PathBuf>) -> Self {
        let resolved = reference_root
            .as_ref()
            .map(|root| release::Release::open(root, &app_root))
            .transpose();
        match resolved {
            Ok(release) => Self {
                app_root,
                reference_root,
                release: release.flatten(),
                blocked: false,
            },
            Err(_) => Self {
                app_root,
                reference_root,
                release: None,
                blocked: true,
            },
        }
    }

    fn read(&mut self, id: Option<&str>) -> Result<Option<Value>> {
        if self.blocked {
            return Err(invalid_release());
        }
        if let Some(release) = &self.release {
            return match release.read(&self.app_root, id) {
                Ok(value) => Ok(value),
                Err(_) => {
                    self.blocked = true;
                    Err(invalid_release())
                }
            };
        }
        match id {
            Some(id) => shards::profile(&self.app_root, id),
            None => shards::view(&self.app_root).map(Some),
        }
    }
}

#[cfg(test)]
mod tests;
