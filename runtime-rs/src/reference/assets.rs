use super::*;
use axum::{
    body::{Body, Bytes},
    extract::Request,
    http::{Method, StatusCode},
};
use futures_util::StreamExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug)]
pub(super) enum Asset {
    Published(release::Image),
    Legacy(PathBuf),
    Missing,
}
struct Published {
    bytes: Vec<u8>,
    _permit: OwnedSemaphorePermit,
}
impl AsRef<[u8]> for Published {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Reader {
    pub(super) fn asset(
        &mut self,
        relative: &str,
        collect: impl FnOnce(&str) -> bool,
    ) -> Result<Asset> {
        if self.blocked {
            return Err(invalid_release());
        }
        if let Some(release) = &self.release {
            return match release.image(&self.app_root, relative, collect) {
                Ok(Some(image)) => Ok(Asset::Published(image)),
                Ok(None) => Ok(Asset::Missing),
                Err(_) => {
                    self.blocked = true;
                    Err(invalid_release())
                }
            };
        }
        let Some(root) = &self.reference_root else {
            return Ok(Asset::Missing);
        };
        let file = root.join(relative);
        io::no_links(&file)?;
        let (Ok(base), Ok(target)) = (root.canonicalize(), file.canonicalize()) else {
            return Ok(Asset::Missing);
        };
        Ok(
            if target.starts_with(&base) && target != base && target.is_file() {
                Asset::Legacy(target)
            } else {
                Asset::Missing
            },
        )
    }
}
pub(super) async fn serve(
    State(state): State<AppState>,
    Extension(readers): Extension<ReaderState>,
    Extension(slots): Extension<Arc<Semaphore>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(relative): Path<String>,
    request: Request,
) -> Response {
    let result = async {
        if !security::is_direct_local(request.headers(), peer.ip()) {
            return Err(ApiError::new(
                403,
                "REFERENCE_LOCAL_ONLY",
                "该参考资源仅限本机使用",
            ));
        }
        if relative.contains(['\\', '\0', ':'])
            || relative
                .split('/')
                .any(|part| part.is_empty() || part.starts_with('.'))
        {
            return Ok(StatusCode::NOT_FOUND.into_response());
        }
        let permit = tokio::select! {
            permit = slots.acquire_owned() => permit.map_err(|_| unavailable())?,
            _ = state.shutdown.cancelled() => return Err(unavailable()),
        };
        let target = relative.clone();
        let head = request.method() == Method::HEAD;
        let condition = request
            .headers()
            .get("if-none-match")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let asset = with_reader(
            readers,
            state.config.content_root(),
            state.config.app_root.clone(),
            &state.shutdown,
            move |reader| {
                Ok::<_, ApiError>((
                    reader.asset(&target, |hash| !head && !fresh(hash, condition.as_deref()))?,
                    permit,
                ))
            },
        )
        .await?;
        let response = match asset {
            (Asset::Missing, _) => StatusCode::NOT_FOUND.into_response(),
            (Asset::Legacy(path), _) => {
                let mut service = tower_http::services::ServeFile::new(path);
                service
                    .try_call(request)
                    .await
                    .map_err(|_| unavailable())?
                    .map(|body| {
                        Body::from_stream(
                            Body::new(body)
                                .into_data_stream()
                                .take_until(state.shutdown.cancelled_owned()),
                        )
                    })
            }
            (Asset::Published(image), permit) => {
                let etag = format!("\"{}\"", image.hash);
                let fresh = fresh(
                    &image.hash,
                    request
                        .headers()
                        .get("if-none-match")
                        .and_then(|h| h.to_str().ok()),
                );
                let mut response = if fresh {
                    StatusCode::NOT_MODIFIED.into_response()
                } else if head {
                    Body::empty().into_response()
                } else {
                    Bytes::from_owner(Published {
                        bytes: image.bytes.ok_or_else(unavailable)?,
                        _permit: permit,
                    })
                    .into_response()
                };
                response.headers_mut().insert("etag", etag.parse().unwrap());
                if !fresh {
                    response
                        .headers_mut()
                        .insert("content-length", image.length.to_string().parse().unwrap());
                    response
                        .headers_mut()
                        .insert("content-type", mime(&relative).parse().unwrap());
                }
                response
            }
        };
        Ok(response)
    }
    .await;
    let mut response = result.unwrap_or_else(IntoResponse::into_response);
    response
        .headers_mut()
        .insert("cache-control", "private, no-cache".parse().unwrap());
    response
}
fn fresh(hash: &str, condition: Option<&str>) -> bool {
    let etag = format!("\"{hash}\"");
    condition.is_some_and(|value| {
        value
            .split(',')
            .any(|tag| tag.trim() == "*" || tag.trim().trim_start_matches("W/") == etag)
    })
}
fn mime(relative: &str) -> &'static str {
    match relative
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}
