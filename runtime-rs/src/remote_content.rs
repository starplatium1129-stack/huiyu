mod access;
mod auth;
pub use access::RemoteAccess;
mod paths;
mod precompressed;
mod projection;

pub use paths::{PUBLIC_DATA_FILES, is_content_path, is_private_asset_path};
pub use precompressed::serve as precompressed;

use crate::{
    config::Config,
    error::{ApiError, Result},
    security,
};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue, Method, Uri},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    sync::{OwnedSemaphorePermit, Semaphore},
};
use tokio_util::sync::CancellationToken;

const MAX_JSON: usize = 16 * 1024 * 1024;
const MAX_IMAGE: usize = 32 * 1024 * 1024;

struct PublishedBytes {
    data: Vec<u8>,
    _permit: OwnedSemaphorePermit,
}
impl AsRef<[u8]> for PublishedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}

/// Authentication only. Passing a gateway token does not grant local authority
/// or authorize any workspace, model import, desktop tool or content release.
pub fn token_guard(
    token: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    peer: IpAddr,
) -> Option<Response> {
    if security::is_direct_local(headers, peer) {
        None
    } else {
        auth::authorize(token, method, uri, headers)
    }
}
pub struct RemoteContent {
    app: PathBuf,
    assets: PathBuf,
    runtime: PathBuf,
    showcase: Vec<PathBuf>,
    readers: Arc<Semaphore>,
    shutdown: CancellationToken,
}
impl RemoteContent {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        let saved: Value = std::fs::read(config.runtime_root.join("config.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let configured = env::var("SCENE_SHOWCASE_DIR")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                saved["sceneShowcaseDir"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
            });
        let absolute = |path: PathBuf| {
            if path.is_absolute() {
                path
            } else {
                env::current_dir()
                    .unwrap_or_else(|_| config.app_root.clone())
                    .join(path)
            }
        };
        let mut showcase: Vec<PathBuf> = configured
            .map(PathBuf::from)
            .map(absolute)
            .into_iter()
            .collect();
        showcase.push(config.ai_workspace_root.join("SceneShowcase"));
        showcase.push(
            config
                .app_root
                .parent()
                .unwrap_or(&config.app_root)
                .join("AI/SceneShowcase"),
        );
        showcase.dedup();
        Self {
            app: config.content_root(),
            runtime: config.runtime_root.clone(),
            assets: absolute(
                env::var_os("AICS_ASSETS_ROOT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| config.app_root.join("assets")),
            ),
            showcase,
            readers: Arc::new(Semaphore::new(4)),
            shutdown,
        }
    }

    /// Call after Host/token checks and before any installed/precompressed/static
    /// source. Returning Some always terminates this namespace, including denial.
    pub async fn serve(
        &self,
        method: &Method,
        uri: &Uri,
        headers: &HeaderMap,
        peer: IpAddr,
    ) -> Option<Response> {
        let domain = paths::namespace(uri.path())?;
        if security::is_direct_local(headers, peer) {
            return None;
        }
        let mut response = if !matches!(*method, Method::GET | Method::HEAD)
            || !paths::canonical(uri.path())
            || domain == "character-references"
            || uri.path() == "/data/character-reference-view.json"
            || is_private_asset_path(uri.path())
        {
            denied()
        } else {
            let work = async {
                let permit = self
                    .readers
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| unpublished())?;
                self.project(domain, uri.path(), permit).await
            };
            tokio::select! {
                result = tokio::time::timeout(Duration::from_secs(30), work) => result.ok().and_then(std::result::Result::ok).unwrap_or_else(denied),
                _ = self.shutdown.cancelled() => denied(),
            }
        };
        response.headers_mut().insert(
            "cache-control",
            HeaderValue::from_static("private, no-store"),
        );
        response.headers_mut().insert(
            "vary",
            HeaderValue::from_static("X-Token, Cookie, X-Forwarded-For"),
        );
        response.headers_mut().insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
        if method == Method::HEAD {
            *response.body_mut() = Body::empty();
        }
        Some(response)
    }
    async fn project(
        &self,
        domain: &str,
        path: &str,
        permit: OwnedSemaphorePermit,
    ) -> Result<Response> {
        let index = self.runtime.join("state/remote-content-release.json");
        let index_bytes = read_bounded(&index, MAX_JSON).await?;
        let release: Value = serde_json::from_slice(&index_bytes)?;
        let entries = release["resources"]
            .as_array()
            .filter(|_| release["version"] == 1)
            .ok_or_else(unpublished)?;
        let mut matching = entries.iter().filter(|entry| entry["url"] == path);
        let entry = matching
            .next()
            .filter(|_| matching.next().is_none())
            .ok_or_else(unpublished)?;
        let digest = entry["sha256"]
            .as_str()
            .filter(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or_else(unpublished)?;
        let size = entry["bytes"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= MAX_IMAGE as u64)
            .ok_or_else(unpublished)? as usize;
        if entry["rating"] != "All" || !entry["reviewedAt"].as_str().is_some_and(reviewed_date) {
            return Err(unpublished());
        }
        let relative = path.get(domain.len() + 2..).ok_or_else(unpublished)?;
        let (root, json_name) = match domain {
            "data" => {
                if !PUBLIC_DATA_FILES.contains(&relative) {
                    return Err(unpublished());
                }
                (self.app.join("data"), Some(relative))
            }
            "scene-showcase" => (
                self.showcase_root().await.ok_or_else(unpublished)?,
                (relative == "manifest.json").then_some(relative),
            ),
            "assets" => (self.assets.clone(), None),
            _ => return Err(unpublished()),
        };
        let mime = if json_name.is_some() {
            "application/json; charset=utf-8"
        } else {
            image_mime(relative).ok_or_else(unpublished)?
        };
        let maximum = if json_name.is_some() {
            MAX_JSON
        } else {
            MAX_IMAGE
        };
        if size > maximum {
            return Err(unpublished());
        }
        let file = rooted(&root, relative).await?;
        let bytes = read_bounded(&file, maximum).await?;
        if bytes.len() != size || hex::encode(Sha256::digest(&bytes)) != digest {
            return Err(unpublished());
        }
        let output = if let Some(name) = json_name {
            serde_json::to_vec(&projection::project(name, &serde_json::from_slice(&bytes)?))?
        } else {
            bytes
        };
        if index_bytes != read_bounded(&index, MAX_JSON).await? {
            return Err(unpublished());
        }
        let size = output.len();
        // Keep the memory admission slot with the actual Bytes allocation, even
        // after Hyper accepts a frame while a slow client stops reading it.
        let bytes = Bytes::from_owner(PublishedBytes {
            data: output,
            _permit: permit,
        });
        let mut response = ([("content-type", mime)], bytes).into_response();
        response
            .headers_mut()
            .insert("content-length", size.to_string().parse().unwrap());
        Ok(response)
    }
    async fn showcase_root(&self) -> Option<PathBuf> {
        use icu_collator::{Collator, options::CollatorOptions};
        for root in &self.showcase {
            if tokio::fs::metadata(root.join("manifest.json"))
                .await
                .is_ok_and(|meta| meta.is_file())
            {
                return Some(root.clone());
            }
            let Ok(mut entries) = tokio::fs::read_dir(root).await else {
                continue;
            };
            let mut collections = Vec::new();
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || !entry.file_type().await.is_ok_and(|kind| kind.is_dir())
                {
                    continue;
                }
                if tokio::fs::metadata(entry.path().join("manifest.json"))
                    .await
                    .is_ok_and(|meta| meta.is_file())
                {
                    collections.push((name, entry.path()));
                }
            }
            if !collections.is_empty() {
                let locale: icu_locale::Locale = "zh-CN".parse().ok()?;
                let collator = Collator::try_new(locale.into(), CollatorOptions::default()).ok()?;
                collections.sort_by(|a, b| collator.compare(&b.0, &a.0));
                return collections.into_iter().next().map(|(_, path)| path);
            }
        }
        None
    }
}
fn reviewed_date(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
        || chrono::DateTime::parse_from_rfc2822(value).is_ok()
        || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}
fn image_mime(path: &str) -> Option<&'static str> {
    match path.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}
async fn read_bounded(file: &Path, maximum: usize) -> Result<Vec<u8>> {
    let file = tokio::fs::File::open(file)
        .await
        .map_err(|_| unpublished())?;
    let metadata = file.metadata().await.map_err(|_| unpublished())?;
    if !metadata.is_file() || metadata.len() > maximum as u64 {
        return Err(unpublished());
    }
    let size = metadata.len() as usize;
    let mut bytes = Vec::with_capacity(size + 1);
    file.take((size + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| unpublished())?;
    if bytes.len() != size {
        return Err(unpublished());
    }
    Ok(bytes)
}
pub(super) async fn rooted(root: &Path, relative: &str) -> Result<PathBuf> {
    let (root, file) = tokio::try_join!(
        tokio::fs::canonicalize(root),
        tokio::fs::canonicalize(root.join(relative))
    )
    .map_err(|_| unpublished())?;
    if file == root || !file.starts_with(&root) {
        return Err(unpublished());
    }
    Ok(file)
}
fn unpublished() -> ApiError {
    ApiError::new(
        403,
        "CONTENT_NOT_PUBLISHED",
        "此内容尚未审核为远程可用，请在本机工作室查看。",
    )
}
fn denied() -> Response {
    unpublished().into_response()
}

#[cfg(test)]
mod tests;
