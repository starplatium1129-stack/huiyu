use super::*;
use crate::download_transport::{self as transfer, CopyError, CopyEvent, Error};
use tokio::io::AsyncSeekExt;
use tokio::io::AsyncWriteExt;
#[path = "setup_sources.rs"]
mod sources;

fn error(error: Error) -> ApiError {
    match error {
        Error::Cancelled => ApiError::new(409, "CANCELLED", "下载已取消"),
        Error::Timeout => ApiError::new(504, "DOWNLOAD_TIMEOUT", "下载响应超时，请检查网络后重试"),
        Error::Network => ApiError::new(502, "DOWNLOAD_FAILED", "模型下载中断，请检查网络后重试"),
        Error::Status(status) => ApiError::new(
            502,
            if matches!(status, 408 | 429 | 500..=599) { "DOWNLOAD_RETRYABLE_HTTP" } else { "DOWNLOAD_HTTP" },
            format!("固定来源返回 HTTP {status}，请检查来源访问权限后重试"),
        ),
        Error::Range => ApiError::new(
            502,
            "RANGE_MISMATCH",
            "来源续传范围不匹配，未发布；请核对来源后重试",
        ),
        Error::Size => ApiError::new(
            502,
            "SIZE_MISMATCH",
            "来源文件大小与固定清单不符，已停止下载",
        ),
        Error::Incomplete => {
            ApiError::new(502, "DOWNLOAD_FAILED", "下载不完整，未发布模型文件；请重试")
        }
        Error::Encoding | Error::Redirect => {
            ApiError::new(502, "DOWNLOAD_HTTP", "来源响应编码或重定向不符合下载策略")
        }
        Error::Io(error) => io_error(error),
    }
}
pub(super) async fn write(
    plan: &DownloadPlan,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
    output: &mut tokio::io::BufWriter<tokio::fs::File>,
) -> Result<u64> {
    let mirror = plan.allow_mirror.then(|| transfer::public_mirror(&plan.url)).flatten();
    let mut sources = Vec::new();
    sources.push(plan.url.clone());
    if let Some(mirror) = sources::model_mirror(plan) { sources.push(mirror); }
    if let Some(mirror) = mirror { sources.push(mirror); }
    sources::order(plan, client, cancel, &mut sources).await?;
    let mut last = None;
    for round in 0..3 {
        for source in &sources {
            stopped(cancel, send)?;
            let mut retained = 0;
            let failure = match write_source(plan, source, client, send, cancel, output, &mut retained).await {
                Ok(bytes) => return Ok(bytes),
                Err(failure) => failure,
            };
            let transient = matches!(failure.code.as_str(), "DOWNLOAD_FAILED" | "DOWNLOAD_TIMEOUT" | "DOWNLOAD_RETRYABLE_HTTP");
            // A missing or denied mirror may fall back to the publisher. Auth,
            // filesystem and integrity failures never trigger repeated requests.
            let mirror_unavailable = source != &plan.url && matches!(failure.code.as_str(),
                "DOWNLOAD_HTTP" | "DOWNLOAD_ACCESS" | "SIZE_MISMATCH" | "RANGE_MISMATCH");
            if !transient && !mirror_unavailable { return Err(failure); }
            output.flush().await.map_err(io_error)?;
            if mirror_unavailable {
                // Discard only bytes added by a protocol-invalid mirror. Keep
                // the earlier resumable prefix when falling back to the publisher.
                output.get_ref().set_len(retained).await.map_err(io_error)?;
                output.seek(std::io::SeekFrom::Start(retained)).await.map_err(io_error)?;
            }
            last = Some(failure);
        }
        if round == 2 { break; }
        let received = output.get_ref().metadata().await.map_err(io_error)?.len();
        let _ = send.try_send(json!({"type":"progress","modelId":plan.id,"phase":"downloading",
            "bytesRead":received,"expectedBytes":plan.spec.bytes,
            "message":format!("连接中断，正在重试（{}/2）；已下载部分保留", round + 1)}));
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(error(Error::Cancelled)),
            _ = tokio::time::sleep(Duration::from_secs(1 << round)) => {}
        }
    }
    let mut failure = last.unwrap();
    failure.message.push_str("；已自动重试 2 次，已下载部分保留，可点击重试继续");
    Err(failure)
}
async fn write_source(
    plan: &DownloadPlan,
    source: &str,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
    output: &mut tokio::io::BufWriter<tokio::fs::File>,
    retained: &mut u64,
) -> Result<u64> {
    let mut count = output.get_ref().metadata().await.map_err(io_error)?.len();
    if count > plan.spec.bytes {
        output.get_ref().set_len(0).await.map_err(io_error)?;
        count = 0;
    }
    *retained = count;
    output
        .seek(std::io::SeekFrom::Start(count))
        .await
        .map_err(io_error)?;
    download_progress(plan, send, source, count);
    if count == plan.spec.bytes {
        return Ok(count);
    }
    let mut headers = reqwest::header::HeaderMap::new();
    if count > 0 {
        headers.insert("range", format!("bytes={count}-").parse().unwrap());
    }
    let url = url::Url::parse(source).map_err(|_| ApiError::invalid("模型来源地址无效"))?;
    let timeout = if plan.allow_mirror && transfer::public_mirror(&plan.url).is_some() { 15 } else { 60 };
    let response = transfer::response(client, url, headers, Duration::from_secs(timeout), cancel, false)
        .await
        .map_err(error)?;
    if !response.status().is_success() && source.starts_with("https://civitai.com/") {
        return Err(if matches!(response.status().as_u16(), 408 | 429 | 500..=599) {
            error(Error::Status(response.status().as_u16()))
        } else { civitai_failure(&format!("（HTTP {}）", response.status().as_u16())) });
    }
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(ApiError::new(403, "DOWNLOAD_ACCESS", "下载来源要求访问许可或拒绝请求，请在来源页面核对访问权；不会将授权请求转到镜像"));
    }
    if response.status().is_success() && response.headers().get("content-type")
        .and_then(|value| value.to_str().ok()).is_some_and(|value| {
            matches!(value.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str(), "text/html" | "application/xhtml+xml")
        }) {
        return Err(ApiError::new(502, "DOWNLOAD_HTTP", "下载来源返回了网页而非文件，未写入；请检查来源或换源重试"));
    }
    // A full-file request keeps the model installer's existing HTTP status contract.
    if count == 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(error(Error::Status(206)));
    }
    let start = transfer::range(&response, count, plan.spec.bytes, None).map_err(error)?;
    if start == 0 && count > 0 {
        output.get_ref().set_len(0).await.map_err(io_error)?;
        *retained = 0;
        output
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(io_error)?;
    }
    transfer::copy(
        response,
        output,
        start,
        plan.spec.bytes,
        Duration::from_secs(60),
        cancel,
        |event| {
            stopped(cancel, send)?;
            if let CopyEvent::AfterWrite {
                received,
                report: true,
            } = event
            {
                download_progress(plan, send, source, received);
            }
            Ok(())
        },
    )
    .await
    .map_err(|failure| match failure {
        CopyError::Transfer(cause) => error(cause),
        CopyError::Observer(cause) => cause,
    })
}
fn download_progress(plan: &DownloadPlan, send: &Sender<Value>, source: &str, received: u64) {
    let host = url::Url::parse(source).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_default();
    let _ = send.try_send(json!({"type":"progress","modelId":plan.id,"phase":"downloading",
        "bytesRead":received,"expectedBytes":plan.spec.bytes,"message":format!("下载中（{host}）：{}",plan.spec.path)}));
}
fn civitai_failure(status: &str) -> ApiError {
    ApiError::new(502, "DOWNLOAD_ACCESS", format!("Civitai 下载来源不可达或需要登录{status}；可从来源页面下载固定版本，在准备页填写已有权重路径后继续，编码器和 VAE 仍会单独准备"))
}
