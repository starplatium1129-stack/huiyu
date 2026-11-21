use crate::{
    AppState,
    error::{ApiError, Result},
    generation::RateLimit,
};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const COOKIE: &str = "__Host-huiyu_guest";
const SESSION_SECONDS: u64 = 7 * 24 * 60 * 60;
pub(crate) const READY_PATH: &str = "/api/guest/ready";

/// Only the dedicated loopback listener can insert this marker.
#[derive(Clone)]
pub(crate) struct Guest;

pub(crate) struct Share {
    pub invite: String,
    pub probe: String,
    pub origin: RwLock<Option<url::Url>>,
    pub cancel: CancellationToken,
    signing_key: Uuid,
    files: HashMap<String, GuestFile>,
    logins: RateLimit,
    cancellations: RateLimit,
    searches: RateLimit,
}

struct GuestFile {
    bytes: Bytes,
    content_type: &'static str,
}

impl Share {
    pub async fn new(
        state: &AppState,
        invite: String,
        signing_key: Uuid,
        cancel: CancellationToken,
    ) -> Result<Arc<Self>> {
        let root = state.config.app_root.join("dist/_guest");
        let files = tokio::task::spawn_blocking(move || guest_files(root))
            .await
            .ok()
            .flatten()
            .ok_or_else(|| {
                ApiError::new(
                    503,
                    "SHARE_WEB_UNAVAILABLE",
                    "好友试玩页面缺失，请更新桌面端或重新构建网页",
                )
            })?;
        Ok(Arc::new(Self {
            invite,
            cancel,
            signing_key,
            files,
            probe: Uuid::new_v4().simple().to_string(),
            origin: RwLock::new(None),
            logins: RateLimit::with("好友邀请", 30, 500),
            cancellations: RateLimit::with("好友出图取消", 12, 5000),
            searches: RateLimit::with("好友素材查询", 30, 500),
        }))
    }

    pub fn router(
        self: &Arc<Self>,
        state: AppState,
        images: Arc<crate::images::ImageService>,
    ) -> Router {
        Router::new()
            .merge(crate::images::router(images))
            .route(READY_PATH, get(ready))
            .route("/api/guest/catalog", get(catalog))
            .route(
                "/api/guest/session",
                post(login).layer(DefaultBodyLimit::max(1024)),
            )
            .fallback(serve_file)
            .layer(axum::Extension(self.clone()))
            .layer(middleware::from_fn_with_state(
                state.clone(),
                crate::admission::track,
            ))
            .layer(middleware::from_fn_with_state(self.clone(), guard))
            .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(
                Duration::from_secs(15),
            ))
            .with_state(state)
    }

    fn signature(&self, session: &str) -> String {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(self.signing_key.as_bytes()).expect("HMAC key");
        mac.update(b"huiyu-friend-share:v1:");
        mac.update(session.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn browser_id(&self, headers: &HeaderMap) -> Option<Uuid> {
        let prefix = format!("{COOKIE}=");
        let cookie = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|header| header.to_str().ok())
            .flat_map(|cookie| cookie.split(';'))
            .find_map(|part| part.trim().strip_prefix(&prefix))?;
        let (session, signature) = cookie.rsplit_once('.')?;
        let (id, expires) = session.split_once('.')?;
        let expires = expires.parse::<u64>().ok()?;
        if expires <= unix_seconds()
            || !crate::remote_content::token_matches(&self.signature(session), signature)
        {
            return None;
        }
        Uuid::parse_str(id).ok()
    }
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn ready(axum::Extension(share): axum::Extension<Arc<Share>>) -> Json<Value> {
    Json(json!({"ready":share.probe}))
}

async fn catalog(
    State(state): State<AppState>,
    axum::Extension(share): axum::Extension<Arc<Share>>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
) -> Result<Response> {
    if let Some(response) = share.searches.check(false) {
        return Ok(response);
    }
    state.host.check_running()?;
    let mut value = crate::images::remote::muse::guest_catalog(&state, &uri).await?;
    value["ok"] = json!(true);
    Ok(Json(value).into_response())
}

#[derive(Deserialize)]
struct Invite {
    invite: String,
}

async fn login(
    axum::Extension(share): axum::Extension<Arc<Share>>,
    headers: HeaderMap,
    Json(input): Json<Invite>,
) -> Result<Response> {
    if let Some(response) = share.logins.check(false) {
        return Ok(response);
    }
    if !crate::remote_content::token_matches(&share.invite, &input.invite) {
        return Err(unauthorized());
    }
    let id = share.browser_id(&headers).unwrap_or_else(Uuid::new_v4);
    let session = format!("{}.{}", id.simple(), unix_seconds() + SESSION_SECONDS);
    let signature = share.signature(&session);
    let cookie = format!(
        "{COOKIE}={session}.{signature}; Path=/; Max-Age={SESSION_SECONDS}; Secure; HttpOnly; SameSite=Lax"
    );
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("signed cookie"),
    );
    Ok(response)
}

async fn guard(State(share): State<Arc<Share>>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let method = request.method();
    let headers = request.headers();
    let read = matches!(*method, Method::GET | Method::HEAD);
    let origin = share.origin.read().unwrap().clone();
    let allowed_host = origin.as_ref().is_some_and(|url| {
        headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|host| {
                url.host_str()
                    .is_some_and(|known| host.eq_ignore_ascii_case(known))
            })
    });
    let status = if share.cancel.is_cancelled() || !allowed_host {
        ApiError::new(503, "SHARE_UNAVAILABLE", "好友试玩暂未连接").into_response()
    } else if !read
        && !origin.as_ref().is_some_and(|url| {
            headers
                .get(header::ORIGIN)
                .is_some_and(|value| value == url.origin().ascii_serialization().as_str())
        })
    {
        StatusCode::FORBIDDEN.into_response()
    } else if (read && (path == READY_PATH || share.files.contains_key(path)))
        || (*method == Method::POST && path == "/api/guest/session")
    {
        next.run(request).await
    } else if (read && path == "/api/guest/catalog") || image_path(path, method) {
        if let Some(browser) = share.browser_id(headers) {
            if *method == Method::DELETE
                && let Some(response) = share.cancellations.check(false)
            {
                return secure_headers(response);
            }
            // The existing image handlers derive their ownership from x-token.
            // Replace all caller credentials and force non-local admission.
            let headers = request.headers_mut();
            headers.insert(
                "x-token",
                HeaderValue::from_str(&format!("guest-{browser}")).unwrap(),
            );
            headers.insert("x-forwarded-host", HeaderValue::from_static("huiyu-guest"));
            request.extensions_mut().insert(Guest);
            next.run(request).await
        } else {
            unauthorized().into_response()
        }
    } else {
        StatusCode::NOT_FOUND.into_response()
    };
    secure_headers(status)
}

fn secure_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    if !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    headers.insert("content-security-policy", HeaderValue::from_static(
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    response
}

fn unauthorized() -> ApiError {
    ApiError::new(401, "GUEST_INVITE_REQUIRED", "请重新打开房主发来的邀请链接")
}

fn image_path(path: &str, method: &Method) -> bool {
    let Some(path) = path.strip_prefix("/api/anima/") else {
        return false;
    };
    let valid_id = |id: &str| Uuid::parse_str(id).is_ok();
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["status"] => matches!(*method, Method::GET | Method::HEAD),
        ["jobs"] => *method == Method::POST,
        ["jobs", id] => matches!(*method, Method::GET | Method::HEAD) && valid_id(id),
        ["requests", id] => {
            matches!(*method, Method::GET | Method::HEAD | Method::DELETE) && valid_id(id)
        }
        ["jobs", id, "result"] => matches!(*method, Method::GET | Method::HEAD) && valid_id(id),
        _ => false,
    }
}

async fn serve_file(
    axum::Extension(share): axum::Extension<Arc<Share>>,
    request: Request,
) -> Response {
    let Some(file) = share.files.get(request.uri().path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let body = if request.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(file.bytes.clone())
    };
    let mut response = Response::new(body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(file.content_type),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, file.bytes.len().into());
    if request.uri().path().starts_with("/_app/") {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    response
}

fn guest_files(root: PathBuf) -> Option<HashMap<String, GuestFile>> {
    let root = root.canonicalize().ok()?;
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(root.join(".vite/manifest.json")).ok()?).ok()?;
    // Snapshot the small guest bundle so an in-place web rebuild cannot
    // invalidate a live invitation or remove one of its hashed imports.
    let mut remaining = 4 * 1024 * 1024;
    let mut load = |path: &str, content_type| -> Option<GuestFile> {
        use std::io::Read as _;
        let file = root.join(path).canonicalize().ok()?;
        if !file.starts_with(&root) || !file.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        std::fs::File::open(file)
            .ok()?
            .take(remaining + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        remaining = remaining.checked_sub(bytes.len() as u64)?;
        Some(GuestFile {
            bytes: bytes.into(),
            content_type,
        })
    };
    let mut files = HashMap::from([(
        "/try".to_owned(),
        load("try.html", "text/html; charset=utf-8")?,
    )]);
    let mut entries = vec!["try.html"];
    let mut seen = HashSet::new();
    while let Some(key) = entries.pop() {
        if !seen.insert(key) {
            continue;
        }
        let entry = manifest.get(key)?;
        for path in entry["file"].as_str().into_iter().chain(
            ["css", "assets"]
                .into_iter()
                .flat_map(|field| entry[field].as_array().into_iter().flatten())
                .filter_map(Value::as_str),
        ) {
            let name = path.strip_prefix("_app/")?;
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
            {
                return None;
            }
            let content_type = match name.rsplit_once('.')?.1 {
                "js" => "application/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "webp" => "image/webp",
                "svg" => "image/svg+xml",
                _ => return None,
            };
            let url = format!("/{path}");
            if let std::collections::hash_map::Entry::Vacant(entry) = files.entry(url) {
                entry.insert(load(path, content_type)?);
            }
        }
        for field in ["imports", "dynamicImports"] {
            entries.extend(
                entry[field]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            );
        }
    }
    Some(files)
}
