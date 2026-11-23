use super::{Http, family, result_part};
use crate::{
    AppState,
    images::{ApiError, Output, generation},
};
use axum::{
    Extension,
    body::Bytes,
    extract::{ConnectInfo, OriginalUri, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, header},
    response::{IntoResponse, Response},
};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};

struct SharedBytes(Arc<Vec<u8>>);
impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}
pub(super) async fn result(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    use crate::http_media::{self, Source};
    let result = async {
        state.host.check_running()?;
        let owner = generation::request_owner(&headers, peer, &query);
        let family = family(&uri);
        let lineart = uri.path().ends_with("/lineart");
        let output = http.service.result(&id, &owner, family).await?;
        let (output, etag) = if lineart {
            (
                http.service.lineart_result(&id, &owner, output).await?,
                None,
            )
        } else {
            let etag = if http
                .service
                .backend
                .remote_store()
                .is_some_and(|store| store.owner == owner)
            {
                let receipt = http.service.get_job(&id, &owner, family).await?;
                if receipt["resultBytes"].as_u64() != Some(output.len()) {
                    return Err(ApiError::new(
                        409,
                        "RESULT_CHANGED",
                        "原图与回执长度不符，请重新查询任务",
                    ));
                }
                let sha = receipt["resultSha256"]
                    .as_str()
                    .filter(|sha| sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
                    .ok_or_else(|| {
                        ApiError::new(
                            409,
                            "RESULT_DIGEST_MISSING",
                            "原图暂缺校验值，请重新查询任务",
                        )
                    })?;
                Some(format!("\"{sha}\""))
            } else {
                None
            };
            (output, etag)
        };
        let mime = output.mime().to_string();
        let (source, length) = match output {
            Output::Bytes { bytes, .. } => {
                let length = bytes.len() as u64;
                (Source::Bytes(Bytes::from_owner(SharedBytes(bytes))), length)
            }
            Output::File { path, bytes, .. } => {
                let root =
                    tokio::fs::canonicalize(http.service.config.runtime_root.join("outputs/anima"))
                        .await?;
                let file = tokio::fs::canonicalize(path).await?;
                if !file.starts_with(root) {
                    return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
                }
                let file = tokio::fs::File::open(file).await?;
                let stat = file.metadata().await?;
                if !stat.is_file() {
                    return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
                }
                if stat.len() != bytes {
                    return Err(ApiError::new(409, "RESULT_CHANGED", "原图在读取前发生变化"));
                }
                (
                    Source::Opened(file, http.service.shutdown.clone()),
                    stat.len(),
                )
            }
        };
        if let Some(part) = query.get("part") {
            if headers.contains_key(header::RANGE) {
                return Err(ApiError::invalid(
                    "分片请求无需 Range；请单独使用 part 或 Range",
                ));
            }
            let digest = etag
                .as_deref()
                .and_then(|value| value.strip_prefix('"')?.strip_suffix('"'))
                .ok_or_else(|| ApiError::invalid("分片只适用于带 SHA-256 回执的远程成图"))?;
            return result_part::serve(source, length, digest, part, query.get("count"), &method)
                .await;
        }
        let range = headers
            .get(header::RANGE)
            .filter(|_| {
                method == Method::GET
                    && headers.get(header::IF_RANGE).is_none_or(|value| {
                        etag.as_deref()
                            .is_some_and(|etag| value.as_bytes() == etag.as_bytes())
                    })
            })
            .map(|value| value.to_str().unwrap_or(""));
        let mut response = match http_media::range(range, length) {
            Ok(range) => {
                http_media::stream(&method, range, source, http.service.shutdown.clone()).await?
            }
            Err(response) => response,
        };
        let headers = response.headers_mut();
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store, no-transform"),
        );
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        if let Ok(mime) = HeaderValue::from_str(&mime) {
            headers.insert(header::CONTENT_TYPE, mime);
        }
        if let Some(etag) = etag.and_then(|value| HeaderValue::from_str(&value).ok()) {
            headers.insert(header::ETAG, etag);
        }
        Ok::<_, ApiError>(response)
    }
    .await;
    match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}
