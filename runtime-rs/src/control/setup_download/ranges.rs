use super::*;
use futures_util::{StreamExt, stream};
use std::{
    convert::Infallible,
    sync::atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed},
};

pub(super) const MIN_BYTES: u64 = 128 * 1024 * 1024;
const SEGMENT_BYTES: u64 = 16 * 1024 * 1024;
const CONCURRENCY: usize = 3;
const HEADER_TIMEOUT: Duration = Duration::from_secs(20);
const IDLE_TIMEOUT: Duration = Duration::from_secs(25);

struct Progress {
    received: AtomicU64,
    retrying: AtomicUsize,
}

pub(super) enum Outcome {
    Complete(u64),
    Resume { try_other_source: bool },
}

pub(super) async fn write(
    plan: &DownloadPlan,
    source: &str,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
    output: &mut tokio::io::BufWriter<tokio::fs::File>,
    start: u64,
) -> Result<Outcome> {
    stopped(cancel, send)?;
    let url = url::Url::parse(source).map_err(|_| ApiError::invalid("模型来源地址无效"))?;
    let host = url.host_str().unwrap_or_default();
    let total = plan.spec.bytes;
    let progress = Progress {
        received: AtomicU64::new(start),
        retrying: AtomicUsize::new(0),
    };
    let mut speed = Speed::new(start);
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    output
        .seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(io_error)?;
    download_progress(plan, send, "connecting", host, start, None);

    // Ordered writes retain the pre-existing .part format and bound buffered
    // data to three segments per active file. A drop can only lose the window.
    let mut jobs = stream::iter((start..total).step_by(SEGMENT_BYTES as usize))
        .map(|start| {
            let end = (start + SEGMENT_BYTES).min(total) - 1;
            fetch_segment(client, &url, start, end, total, cancel, &progress)
        })
        .buffered(CONCURRENCY);
    let mut committed = start;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(error(Error::Cancelled)),
            segment = jobs.next() => {
                let Some((bytes, result)) = segment else { break };
                stopped(cancel, send)?;
                if matches!(result, Err(Error::Cancelled)) {
                    return Err(error(Error::Cancelled));
                }
                output.write_all(&bytes).await.map_err(io_error)?;
                committed += bytes.len() as u64;
                if let Err(failure) = result {
                    output.flush().await.map_err(io_error)?;
                    let try_other_source = !matches!(failure, Error::Range | Error::Status(200 | 416));
                    let _ = send.try_send(json!({
                        "type":"progress","modelId":plan.id,"phase":"retrying",
                        "bytesRead":committed,"expectedBytes":total,
                        "message":"分段连接不可用，正在从已写入的位置继续",
                    }));
                    return Ok(Outcome::Resume { try_other_source });
                }
            }
            _ = tick.tick() => {
                stopped(cancel, send)?;
                let received = progress.received.load(Relaxed);
                let rate = speed.sample(received);
                let retrying = progress.retrying.load(Relaxed) > 0;
                let _ = send.try_send(json!({
                    "type":"progress","modelId":plan.id,
                    "phase":if retrying {"retrying"} else if received > start {"downloading"} else {"connecting"},
                    "bytesRead":received,"expectedBytes":total,"source":host,"bytesPerSecond":rate,
                    "message":if retrying {"连接波动，正在重试分段"} else {"并行分段下载"},
                }));
            }
        }
    }
    download_progress(
        plan,
        send,
        "downloading",
        host,
        committed,
        speed.sample(committed),
    );
    Ok(Outcome::Complete(committed))
}

async fn fetch_segment(
    client: &reqwest::Client,
    url: &url::Url,
    start: u64,
    end: u64,
    total: u64,
    cancel: &CancellationToken,
    progress: &Progress,
) -> (Vec<u8>, std::result::Result<(), Error>) {
    let mut bytes = Vec::with_capacity((end - start + 1) as usize);
    for attempt in 0..3 {
        let offset = start + bytes.len() as u64;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("range", format!("bytes={offset}-{end}").parse().unwrap());
        let response =
            transfer::response(client, url.clone(), headers, HEADER_TIMEOUT, cancel, false).await;
        let mut delay =
            Duration::from_millis((1000 << attempt) + (start / SEGMENT_BYTES % 7) * 120);
        let failure = match response {
            Ok(response) => match transfer::partial_range(&response, offset, end, total, None) {
                Ok(()) => {
                    let mut last = offset;
                    let copied = transfer::copy(
                        response,
                        &mut bytes,
                        offset,
                        end + 1,
                        IDLE_TIMEOUT,
                        cancel,
                        |event| {
                            if let CopyEvent::AfterWrite { received, .. } = event {
                                progress.received.fetch_add(received - last, Relaxed);
                                last = received;
                            }
                            Ok::<_, Infallible>(())
                        },
                    )
                    .await;
                    match copied {
                        Ok(_) => return (bytes, Ok(())),
                        Err(CopyError::Transfer(Error::Size)) => {
                            progress.received.fetch_sub(last - offset, Relaxed);
                            bytes.truncate((offset - start) as usize);
                            Error::Size
                        }
                        Err(CopyError::Transfer(failure)) => failure,
                        Err(CopyError::Observer(never)) => match never {},
                    }
                }
                Err(failure) => {
                    if matches!(failure, Error::Status(429 | 503)) {
                        delay = retry_after(&response).unwrap_or(delay);
                    }
                    failure
                }
            },
            Err(failure) => failure,
        };
        let retryable = matches!(
            failure,
            Error::Timeout
                | Error::Network
                | Error::Incomplete
                | Error::Status(408 | 429 | 500..=599)
        );
        if !retryable || attempt == 2 || start + bytes.len() as u64 > end {
            return (bytes, Err(failure));
        }
        progress.retrying.fetch_add(1, Relaxed);
        let cancelled = tokio::select! {
            biased;
            _ = cancel.cancelled() => true,
            _ = tokio::time::sleep(delay) => false,
        };
        progress.retrying.fetch_sub(1, Relaxed);
        if cancelled {
            return (bytes, Err(Error::Cancelled));
        }
    }
    unreachable!("the last range attempt always returns")
}

fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    let value = response.headers().get("retry-after")?.to_str().ok()?.trim();
    let seconds = value.parse::<u64>().ok().or_else(|| {
        let until = chrono::DateTime::parse_from_rfc2822(value)
            .ok()?
            .timestamp();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
        Some(until.saturating_sub(now).max(0) as u64)
    })?;
    Some(Duration::from_secs(seconds.clamp(1, 60)))
}
