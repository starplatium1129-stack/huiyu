use super::*;
use crate::download_transport::{self as transfer, CopyError, CopyEvent, Error};
use tokio::io::AsyncSeekExt;

fn error(error: Error) -> ApiError {
    match error {
        Error::Cancelled => ApiError::new(409, "CANCELLED", "下载已取消"),
        Error::Timeout => ApiError::new(504, "DOWNLOAD_TIMEOUT", "下载响应超时，请检查网络后重试"),
        Error::Network => ApiError::new(502, "DOWNLOAD_FAILED", "模型下载中断，请检查网络后重试"),
        Error::Status(status) => ApiError::new(
            502,
            "DOWNLOAD_HTTP",
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
    let mut count = output.get_ref().metadata().await.map_err(io_error)?.len();
    if count > plan.spec.bytes {
        output.get_ref().set_len(0).await.map_err(io_error)?;
        count = 0;
    }
    output
        .seek(std::io::SeekFrom::Start(count))
        .await
        .map_err(io_error)?;
    progress(plan, send, "downloading", count);
    if count == plan.spec.bytes {
        return Ok(count);
    }
    let mut headers = reqwest::header::HeaderMap::new();
    if count > 0 {
        headers.insert("range", format!("bytes={count}-").parse().unwrap());
    }
    let url = url::Url::parse(&plan.url).map_err(|_| ApiError::invalid("模型来源地址无效"))?;
    let response = transfer::response(client, url, headers, Duration::from_secs(60), cancel, false)
        .await
        .map_err(error)?;
    // A full-file request keeps the model installer's existing HTTP status contract.
    if count == 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(error(Error::Status(206)));
    }
    let start = transfer::range(&response, count, plan.spec.bytes, None).map_err(error)?;
    if start == 0 && count > 0 {
        output.get_ref().set_len(0).await.map_err(io_error)?;
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
                progress(plan, send, "downloading", received);
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
