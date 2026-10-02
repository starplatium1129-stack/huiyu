//! Bounded single-stream resume for the desktop updater, not a general downloader.
use super::cache::{strong_etag, Cache, Record, MAX_BYTES};
use reqwest::{header, Client, ClientBuilder, Response, StatusCode, Url};
use std::time::Duration;

pub(super) fn configure_client(client: ClientBuilder) -> ClientBuilder {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    client
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(45))
        // File offsets must describe the transferred representation exactly.
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
}

pub(super) fn client(update: &tauri_plugin_updater::Update) -> Result<Client, String> {
    let mut builder = configure_client(Client::builder()).user_agent("tauri-plugin-updater/2.13.0");
    if update.no_proxy {
        builder = builder.no_proxy();
    } else if let Some(proxy) = &update.proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy.as_str()).map_err(|e| e.to_string())?);
    }
    builder.build().map_err(|e| e.to_string())
}

fn text(response: &Response, name: header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)?
        .to_str()
        .ok()
        .map(str::to_owned)
}

pub(super) fn resource(url: &Url) -> String {
    let mut identity = url.clone();
    identity.set_fragment(None);
    // GitHub asset UUID paths identify the artifact; only their authorization
    // query expires. For other servers query parameters may select another file,
    // so require the entire final URL to match. Never persist redirect credentials.
    if url.host_str() == Some("release-assets.githubusercontent.com")
        && url.path().starts_with("/github-production-release-asset/")
    {
        identity.set_query(None);
    }
    ring::digest::digest(&ring::digest::SHA256, identity.as_str().as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn range(value: &str) -> Option<(u64, u64, u64)> {
    let (span, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total && total <= MAX_BYTES).then_some((start, end, total))
}

fn network(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "更新下载超时（连接超时或连续 45 秒未收到数据）；已保留可用缓存，重试时检查续传".into()
    } else {
        // Do not display expiring redirect URLs or their query credentials.
        format!(
            "更新下载中断，已保留可用缓存，重试时检查续传：{}",
            error.without_url()
        )
    }
}

/// Dropping this future closes the response. Writes are synchronous and bounded
/// by a received chunk, so no detached file-write task can race the next retry.
pub(super) async fn fetch(
    client: &Client,
    url: &Url,
    headers: &header::HeaderMap,
    cache: &mut Cache,
    mut progress: impl FnMut(u64, Option<u64>, u64),
) -> Result<(), String> {
    let identity = cache.record.identity.clone();
    let mut offset = cache.len()?;
    let mut transferred = 0;
    progress(offset, cache.record.total, transferred);
    if offset > 0 && cache.record.total == Some(offset) {
        return Ok(()); // Caller still verifies all cached bytes before installation.
    }
    // At most one clean retry for an unusable partial response, never a loop of
    // retries after network errors or a silent unbounded background download.
    for attempt in 0..2 {
        let mut request_headers = headers.clone();
        request_headers.remove(header::RANGE);
        request_headers.remove(header::IF_RANGE);
        request_headers.insert(
            header::ACCEPT_ENCODING,
            header::HeaderValue::from_static("identity"),
        );
        request_headers.insert(
            header::ACCEPT,
            header::HeaderValue::from_static("application/octet-stream"),
        );
        let mut request = client.get(url.clone()).headers(request_headers);
        if offset > 0 {
            request = request
                .header(header::RANGE, format!("bytes={offset}-"))
                .header(header::IF_RANGE, cache.record.etag.as_deref().unwrap_or(""));
        }
        let mut response = request.send().await.map_err(network)?;
        let status = response.status();
        let etag = text(&response, header::ETAG).filter(|s| strong_etag(s));
        let final_resource = resource(response.url());
        let length = response.content_length();
        let encoding_ok = text(&response, header::CONTENT_ENCODING)
            .is_none_or(|encoding| encoding.eq_ignore_ascii_case("identity"));
        let resumed = text(&response, header::CONTENT_RANGE)
            .as_deref()
            .and_then(range)
            .filter(|(start, end, total)| {
                offset > 0
                    && *start == offset
                    && end + 1 == *total
                    && cache.record.total == Some(*total)
                    && length.is_none_or(|n| n == end - start + 1)
                    && etag == cache.record.etag
                    && final_resource == cache.record.resource
            });

        if (status == StatusCode::PARTIAL_CONTENT && resumed.is_none())
            || status == StatusCode::RANGE_NOT_SATISFIABLE
            || !encoding_ok
        {
            cache.reset(&identity)?;
            offset = 0;
            progress(0, None, transferred);
            if attempt == 0 {
                continue;
            }
            return Err("更新服务器返回的范围或编码无效，请稍后重试".into());
        }
        let total = if status == StatusCode::OK {
            // Ignored Range, changed ETag or unsupported resume: use this complete
            // response after truncation. Never append a 200 body to an old prefix.
            cache.reset(&identity)?;
            offset = 0;
            length
        } else if status == StatusCode::PARTIAL_CONTENT {
            resumed.map(|(_, _, total)| total)
        } else {
            return Err(format!("更新服务器返回 HTTP {status}，请稍后重试"));
        };
        if total.is_some_and(|n| n == 0 || n > MAX_BYTES) {
            cache.reset(&identity)?;
            return Err("更新安装包大小超出允许范围".into());
        }
        cache.record = Record {
            identity: identity.clone(),
            etag,
            resource: final_resource,
            total,
        };
        cache.save()?;
        progress(offset, total, transferred);
        while let Some(chunk) = response.chunk().await.map_err(network)? {
            let end = offset.saturating_add(chunk.len() as u64);
            if end > total.unwrap_or(MAX_BYTES) {
                cache.reset(&identity)?;
                return Err("更新安装包长度不符，缓存已失效，请重试".into());
            }
            cache.append(&chunk)?;
            offset = end;
            transferred += chunk.len() as u64;
            progress(offset, total, transferred);
        }
        if offset == 0 || total.is_some_and(|n| n != offset) {
            return Err("更新安装包未下载完整，重试时检查续传".into());
        }
        return Ok(());
    }
    unreachable!()
}
