use super::*;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

pub(super) async fn write(
    plan: &DownloadPlan,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
    output: &mut tokio::fs::File,
) -> Result<u64> {
    let mut count = output.metadata().await.map_err(io_error)?.len();
    if count > plan.spec.bytes {
        output.set_len(0).await.map_err(io_error)?;
        count = 0;
    }
    output
        .seek(std::io::SeekFrom::Start(count))
        .await
        .map_err(io_error)?;
    progress(plan, send, "downloading", count);
    if count < plan.spec.bytes {
        let mut request = client.get(&plan.url).header("accept-encoding", "identity");
        if count > 0 {
            request = request.header("range", format!("bytes={count}-"));
        }
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err(ApiError::new(409,"CANCELLED","下载已取消")),
            response = tokio::time::timeout(Duration::from_secs(60), request.send()) =>
                response.map_err(|_| ApiError::new(504,"DOWNLOAD_TIMEOUT","来源响应超时，请重试"))?.map_err(|_| ApiError::new(502,"DOWNLOAD_FAILED","无法连接固定模型来源，请检查网络后重试"))?,
        };
        if response.status() == reqwest::StatusCode::PARTIAL_CONTENT && count > 0 {
            let expected = format!(
                "bytes {count}-{}{}",
                plan.spec.bytes - 1,
                format!("/{}", plan.spec.bytes)
            );
            if response
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                != Some(expected.as_str())
            {
                return Err(ApiError::new(
                    502,
                    "RANGE_MISMATCH",
                    "来源续传范围不匹配，未发布；请核对来源后重试",
                ));
            }
        } else if response.status() == reqwest::StatusCode::OK {
            if count > 0 {
                output.set_len(0).await.map_err(io_error)?;
                output
                    .seek(std::io::SeekFrom::Start(0))
                    .await
                    .map_err(io_error)?;
                count = 0;
            }
        } else {
            return Err(ApiError::new(
                502,
                "DOWNLOAD_HTTP",
                format!(
                    "固定来源返回 HTTP {}，请检查来源访问权限后重试",
                    response.status().as_u16()
                ),
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size != plan.spec.bytes - count)
        {
            return Err(ApiError::new(
                502,
                "SIZE_MISMATCH",
                "来源文件大小与固定清单不符，已停止下载",
            ));
        }
        let mut stream = response.bytes_stream();
        let mut last = Instant::now();
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(ApiError::new(409,"CANCELLED","下载已取消")),
                next = tokio::time::timeout(Duration::from_secs(60), stream.next()) => next.map_err(|_| ApiError::new(504,"DOWNLOAD_TIMEOUT","下载响应中断超过 60 秒，请重试"))?,
            };
            let Some(chunk) = next else {
                break;
            };
            let chunk = chunk.map_err(|_| {
                ApiError::new(502, "DOWNLOAD_FAILED", "模型下载中断，请检查网络后重试")
            })?;
            stopped(cancel, send)?;
            count += chunk.len() as u64;
            if count > plan.spec.bytes {
                return Err(ApiError::new(
                    502,
                    "SIZE_MISMATCH",
                    "下载字节超过固定大小，已停止",
                ));
            }
            output.write_all(&chunk).await.map_err(io_error)?;
            if last.elapsed() >= Duration::from_millis(250) || count == plan.spec.bytes {
                progress(plan, send, "downloading", count);
                last = Instant::now();
            }
        }
    }
    Ok(count)
}
