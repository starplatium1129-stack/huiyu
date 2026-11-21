use super::*;
use crate::download_transport::{self as transfer, CopyError, CopyEvent, Error};
use tokio::io::AsyncSeekExt;
use tokio::io::AsyncWriteExt;
#[path = "setup_download/ranges.rs"]
mod ranges;
#[path = "setup_sources.rs"]
mod sources;

fn error(error: Error) -> ApiError {
    match error {
        Error::Cancelled => ApiError::new(409, "CANCELLED", "下载已取消"),
        Error::Timeout => ApiError::new(504, "DOWNLOAD_TIMEOUT", "下载响应超时，请检查网络后重试"),
        Error::Network => ApiError::new(502, "DOWNLOAD_FAILED", "模型下载中断，请检查网络后重试"),
        Error::Status(status) => ApiError::new(
            502,
            if matches!(status, 408 | 429 | 500..=599) {
                "DOWNLOAD_RETRYABLE_HTTP"
            } else {
                "DOWNLOAD_HTTP"
            },
            format!("下载源暂未提供文件（HTTP {status}），请稍后重试"),
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
    let mut sources = vec![plan.url.clone()];
    if let Some(mirror) = sources::model_mirror(plan) {
        sources.push(mirror);
    }
    if plan.allow_mirror {
        let base = sources.clone();
        for url in base {
            for mirror in transfer::public_mirrors(&url) {
                if !sources.contains(&mirror) {
                    sources.push(mirror);
                }
            }
        }
    }
    sources::prioritize(&mut sources);
    let present = output.get_ref().metadata().await.map_err(io_error)?.len();
    if present == plan.spec.bytes {
        return Ok(present);
    }
    let range_capable = if present == 0 || plan.parallel_ranges {
        if sources.len() > 1 {
            let _ = send.try_send(json!({
                "type":"progress","modelId":plan.id,"phase":"connecting",
                "bytesRead":present.min(plan.spec.bytes),"expectedBytes":plan.spec.bytes,
                "message":"正在选择可用下载源",
            }));
        }
        sources::order(plan, client, cancel, &mut sources, present).await?
    } else {
        false
    };
    if plan.parallel_ranges
        && plan.spec.bytes.saturating_sub(present) >= ranges::MIN_BYTES
        && (range_capable || sources.len() == 1)
    {
        match ranges::write(plan, &sources[0], client, send, cancel, output, present).await? {
            ranges::Outcome::Complete(count) => {
                sources::note_success(&sources[0]);
                return Ok(count);
            }
            ranges::Outcome::Resume {
                try_other_source: true,
            } => {
                sources::note_failure(&sources[0]);
                sources.rotate_left(1);
            }
            ranges::Outcome::Resume {
                try_other_source: false,
            } => {}
        }
    }
    let mut last = None;
    let mut origin_failure = None;
    for round in 0..3 {
        let mut restart_source = None;
        let mut retryable = false;
        for source in &sources {
            let failure =
                match write_source(plan, source, client, send, cancel, output, false).await {
                    Ok(bytes) => {
                        sources::note_success(source);
                        return Ok(bytes);
                    }
                    Err(failure) => failure,
                };
            if failure.code == "RANGE_UNSUPPORTED" {
                restart_source.get_or_insert(source);
                continue;
            }
            sources::note_failure(source);
            if transient(&failure) {
                retryable = true;
                last = Some(failure);
            } else if !matches!(
                failure.code.as_str(),
                "DOWNLOAD_HTTP" | "DOWNLOAD_ACCESS" | "SIZE_MISMATCH" | "RANGE_MISMATCH"
            ) {
                return Err(failure);
            } else if source == &plan.url {
                origin_failure = Some(failure);
            } else if last.is_none() {
                last = Some(failure);
            }
            output.flush().await.map_err(io_error)?;
        }
        if let Some(source) = restart_source
            && (!retryable || round == 2)
        {
            match write_source(plan, source, client, send, cancel, output, true).await {
                Ok(bytes) => return Ok(bytes),
                Err(failure) if transient(&failure) && round < 2 => {
                    output.flush().await.map_err(io_error)?;
                    retryable = true;
                    last = Some(failure);
                }
                Err(failure) => return Err(failure),
            }
        }
        if !retryable {
            return Err(origin_failure
                .or(last)
                .unwrap_or_else(|| error(Error::Network)));
        }
        if round == 2 {
            let mut failure = last.unwrap_or_else(|| error(Error::Network));
            failure
                .message
                .push_str("；已自动重试 2 次，可点击重试继续");
            return Err(failure);
        }
        let received = output.get_ref().metadata().await.map_err(io_error)?.len();
        let _ = send.try_send(
            json!({"type":"progress","modelId":plan.id,"phase":"retrying",
            "bytesRead":received,"expectedBytes":plan.spec.bytes,
            "message":format!("连接中断，正在重试（{}/2）；已下载部分保留", round + 1)}),
        );
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(error(Error::Cancelled)),
            _ = tokio::time::sleep(Duration::from_secs(1 << round)) => {}
        }
    }
    Err(error(Error::Network))
}

fn transient(error: &ApiError) -> bool {
    matches!(
        error.code.as_str(),
        "DOWNLOAD_FAILED" | "DOWNLOAD_TIMEOUT" | "DOWNLOAD_RETRYABLE_HTTP"
    )
}

async fn write_source(
    plan: &DownloadPlan,
    source: &str,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
    output: &mut tokio::io::BufWriter<tokio::fs::File>,
    allow_restart: bool,
) -> Result<u64> {
    stopped(cancel, send)?;
    let mut count = output.get_ref().metadata().await.map_err(io_error)?.len();
    if count > plan.spec.bytes {
        output.get_ref().set_len(0).await.map_err(io_error)?;
        count = 0;
    }
    output
        .seek(std::io::SeekFrom::Start(count))
        .await
        .map_err(io_error)?;
    if count == plan.spec.bytes {
        return Ok(count);
    }
    let mut headers = reqwest::header::HeaderMap::new();
    if count > 0 {
        headers.insert("range", format!("bytes={count}-").parse().unwrap());
    }
    let url = url::Url::parse(source).map_err(|_| ApiError::invalid("模型来源地址无效"))?;
    let host = url.host_str().unwrap_or_default().to_owned();
    download_progress(plan, send, "connecting", &host, count, None);
    let timeout = if plan.allow_mirror
        && (!transfer::public_mirrors(&plan.url).is_empty() || sources::model_mirror(plan).is_some())
    {
        15
    } else {
        60
    };
    let response = transfer::response(
        client,
        url,
        headers,
        Duration::from_secs(timeout),
        cancel,
        false,
    )
    .await
    .map_err(error)?;
    if !response.status().is_success() && source.starts_with("https://civitai.com/") {
        return Err(
            if matches!(response.status().as_u16(), 408 | 429 | 500..=599) {
                error(Error::Status(response.status().as_u16()))
            } else {
                civitai_failure(&format!("（HTTP {}）", response.status().as_u16()))
            },
        );
    }
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(ApiError::new(
            403,
            "DOWNLOAD_ACCESS",
            "下载来源要求访问许可或拒绝请求，请在来源页面核对访问权；不会将授权请求转到镜像",
        ));
    }
    if response.status().is_success()
        && response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                matches!(
                    value
                        .split(';')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase()
                        .as_str(),
                    "text/html" | "application/xhtml+xml"
                )
            })
    {
        return Err(ApiError::new(
            502,
            "DOWNLOAD_HTTP",
            "下载来源返回了网页而非文件，未写入；请检查来源或换源重试",
        ));
    }
    // A full-file request keeps the model installer's existing HTTP status contract.
    if count == 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(error(Error::Status(206)));
    }
    let start = transfer::range(&response, count, plan.spec.bytes, None).map_err(error)?;
    if start == 0 && count > 0 {
        if !allow_restart {
            return Err(ApiError::new(
                502,
                "RANGE_UNSUPPORTED",
                "来源未接受续传，正在检查其他来源",
            ));
        }
        output.get_ref().set_len(0).await.map_err(io_error)?;
        output
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(io_error)?;
    }
    download_progress(plan, send, "downloading", &host, start, None);
    let mut meter = Speed::new(start);
    let copied = transfer::copy(
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
                download_progress(
                    plan,
                    send,
                    "downloading",
                    &host,
                    received,
                    meter.sample(received),
                );
            }
            Ok(())
        },
    )
    .await;
    if matches!(&copied, Err(CopyError::Transfer(Error::Size))) {
        // An oversized body is a source error. Preserve the prefix from before this request.
        output.flush().await.map_err(io_error)?;
        output.get_ref().set_len(start).await.map_err(io_error)?;
    }
    copied.map_err(|failure| match failure {
        CopyError::Transfer(cause) => error(cause),
        CopyError::Observer(cause) => cause,
    })
}

struct Speed {
    sampled_at: Instant,
    received: u64,
    rate: Option<f64>,
}

impl Speed {
    fn new(received: u64) -> Self {
        Self {
            sampled_at: Instant::now(),
            received,
            rate: None,
        }
    }

    fn sample(&mut self, received: u64) -> Option<f64> {
        let now = Instant::now();
        let elapsed = now.duration_since(self.sampled_at).as_secs_f64();
        if elapsed >= 1.0 {
            let current = received.saturating_sub(self.received) as f64 / elapsed;
            self.rate = Some(self.rate.map_or(current, |rate| rate * 0.6 + current * 0.4));
            self.sampled_at = now;
            self.received = received;
        }
        self.rate
    }
}

fn download_progress(
    plan: &DownloadPlan,
    send: &Sender<Value>,
    phase: &str,
    host: &str,
    received: u64,
    speed: Option<f64>,
) {
    let _ = send.try_send(json!({"type":"progress","modelId":plan.id,"phase":phase,
        "bytesRead":received,"expectedBytes":plan.spec.bytes,"source":host,"bytesPerSecond":speed}));
}
fn civitai_failure(status: &str) -> ApiError {
    ApiError::new(
        502,
        "DOWNLOAD_ACCESS",
        format!(
            "Civitai 下载来源不可达或需要登录{status}；可从来源页面下载固定版本，在准备页填写已有权重路径后继续，编码器和 VAE 仍会单独准备"
        ),
    )
}
