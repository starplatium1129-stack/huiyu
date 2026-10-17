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
    sync::Arc,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

type Result<T> = std::result::Result<T, ApiError>;
type ReaderState = Arc<Mutex<Option<Reader>>>;

fn unavailable() -> ApiError {
    ApiError::new(503, "REFERENCE_UNAVAILABLE", "参考档案暂不可用")
}
fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(unavailable())
    } else {
        Ok(())
    }
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
        with_reader(
            readers,
            state.config.content_root(),
            state.config.app_root.clone(),
            &state.shutdown,
            // Encode and drop the potentially multi-megabyte view in the same
            // blocking job as its read, not on a Tokio request worker.
            move |reader, cancel| {
                reader
                    .read(id.as_deref(), cancel)
                    .map(|value| value.map(|profile| Json(profile).into_response()))
            },
        )
        .await
    };
    let mut response = match result {
        Ok(Some(response)) => response,
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

async fn with_reader<T: Send + 'static>(
    readers: ReaderState,
    root: PathBuf,
    app_root: PathBuf,
    shutdown: &CancellationToken,
    operation: impl FnOnce(&mut Reader, &CancellationToken) -> Result<T> + Send + 'static,
) -> Result<T> {
    let cancelled = shutdown.child_token();
    let _cancel = cancelled.clone().drop_guard();
    let work = async {
        // Waiting for the shared reader must not occupy Tokio's blocking pool:
        // first-use release verification can be much slower than ordinary reads.
        let mut slot =
            tokio::time::timeout(std::time::Duration::from_secs(30), readers.lock_owned())
                .await
                .map_err(|_| unavailable())?;
        let worker_cancel = cancelled.clone();
        tokio::task::spawn_blocking(move || {
            // Keep the guard in the worker even if the HTTP future is dropped.
            // A queued blocking job can then skip all I/O after cancellation;
            // a running filesystem call retains exclusive access until it ends.
            check_cancel(&worker_cancel)?;
            if slot.is_none() {
                let reader = Reader::new(root, reference_root(&app_root), &worker_cancel)?;
                // An abandoned first request must not cache partial initialization.
                check_cancel(&worker_cancel)?;
                *slot = Some(reader);
            }
            let result = operation(slot.as_mut().unwrap(), &worker_cancel);
            check_cancel(&worker_cancel)?;
            result
        })
        .await
        .map_err(|_| unavailable())?
    };
    tokio::select! { biased;
        _ = cancelled.cancelled() => Err(unavailable()),
        result = work => result,
    }
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
    fn new(
        app_root: PathBuf,
        reference_root: Option<PathBuf>,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let resolved = reference_root
            .as_ref()
            .map(|root| release::Release::open(root, &app_root, cancel))
            .transpose();
        check_cancel(cancel)?;
        Ok(match resolved {
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
        })
    }

    fn read(&mut self, id: Option<&str>, cancel: &CancellationToken) -> Result<Option<Value>> {
        check_cancel(cancel)?;
        if self.blocked {
            return Err(invalid_release());
        }
        if let Some(release) = &self.release {
            let result = release.read(&self.app_root, id, cancel);
            // Cancellation is not evidence that the cached release is corrupt.
            check_cancel(cancel)?;
            return match result {
                Ok(value) => Ok(value),
                Err(_) => {
                    self.blocked = true;
                    Err(invalid_release())
                }
            };
        }
        match id {
            Some(id) => shards::profile(&self.app_root, id, cancel),
            None => shards::view(&self.app_root, cancel).map(Some),
        }
    }
}
