use super::*;
use futures_util::StreamExt;
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;
use tokio::io::AsyncWriteExt;
const MAX_BYTES: u64 = 256 * 1024 * 1024;
static NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:mp4|webm|mov)$").unwrap()
});
fn decoded(value: &str) -> Result<String> {
    let mut current = value.to_string();
    for _ in 0..3 {
        let next = percent_encoding::percent_decode_str(&current)
            .decode_utf8()
            .map_err(|_| ApiError::new(400, "INVALID_RESULT", "结果路径编码无效"))?
            .into_owned();
        if next == current {
            break;
        }
        current = next;
    }
    Ok(current)
}
pub(super) fn reference(value: &Value) -> Result<String> {
    let file = decoded(value["filename"].as_str().unwrap_or(""))?;
    let folder = decoded(value["subfolder"].as_str().unwrap_or(""))?;
    let lower = file.to_ascii_lowercase();
    if !value.is_object()
        || !value["type"]
            .as_str()
            .unwrap_or("output")
            .eq_ignore_ascii_case("output")
        || !folder.is_empty()
        || file.contains(['\\', '/', '\0'])
        || !NAME.is_match(&file)
        || !lower
            .strip_prefix("aics_video")
            .is_some_and(|tail| tail.starts_with(['_', '.', '-']))
    {
        return Err(ApiError::new(
            400,
            "INVALID_RESULT",
            "视频结果路径不在应用允许范围内",
        ));
    }
    Ok(file)
}
fn sniff(content_type: &str, bytes: &[u8], filename: &str) -> Option<(&'static str, &'static str)> {
    let extension = filename.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "mp4" if bytes.get(4..8) == Some(b"ftyp") => Some(("video/mp4", "mp4")),
        "mov" if bytes.get(4..8) == Some(b"ftyp") => Some(("video/quicktime", "mov")),
        "webm" if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) => Some(("video/webm", "webm")),
        "mp4"
            if content_type
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("video/mp4") =>
        {
            Some(("video/mp4", "mp4"))
        }
        _ => None,
    }
}
/// Streams bounded upstream bytes straight into a private temporary file. Neither
/// live delivery nor recovery buffers a 256 MiB video in application memory.
pub(crate) async fn materialize(
    transport: &LocalUpstream,
    host: &str,
    root: &Path,
    id: &str,
    output: &Value,
    cancel: &CancellationToken,
) -> Result<Output> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(ApiError::new(400, "INVALID_RESULT", "视频任务身份无效"));
    }
    let filename = reference(output)?;
    let mut target = crate::upstream::local_url(host)?;
    target.set_path("/view");
    target
        .query_pairs_mut()
        .append_pair("filename", &filename)
        .append_pair("type", "output");
    tokio::fs::create_dir_all(root).await?;
    let canonical_root = tokio::fs::canonicalize(root).await?;
    let pending = root.join(format!(".{id}.{}.part", uuid::Uuid::new_v4()));
    let transfer = async {
        let response = transport
            .client
            .get(target)
            .header("Accept", "application/octet-stream")
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|_| ApiError::new(502, "COMFY_RESULT_ERROR", "ComfyUI 视频读取失败"))?;
        if !response.status().is_success() {
            return Err(ApiError::new(
                502,
                "COMFY_RESULT_ERROR",
                "ComfyUI 视频读取失败",
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BYTES)
        {
            return Err(ApiError::new(
                502,
                "INVALID_RESULT",
                "ComfyUI 返回的视频超过大小限制",
            ));
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let mut stream = response.bytes_stream();
        let mut header = Vec::with_capacity(12);
        let mut remainder = None;
        while header.len() < 12 {
            let Some(chunk) = stream.next().await else {
                break;
            };
            let chunk = chunk
                .map_err(|_| ApiError::new(502, "COMFY_RESULT_ERROR", "ComfyUI 视频响应中断"))?;
            if header.len().saturating_add(chunk.len()) > MAX_BYTES as usize {
                return Err(ApiError::new(
                    502,
                    "INVALID_RESULT",
                    "ComfyUI 返回的视频超过大小限制",
                ));
            }
            let count = (12 - header.len()).min(chunk.len());
            header.extend_from_slice(&chunk[..count]);
            if count < chunk.len() {
                remainder = Some(chunk.slice(count..));
            }
        }
        let (mime, extension) = sniff(&content_type, &header, &filename)
            .filter(|_| !header.is_empty())
            .ok_or_else(|| ApiError::new(502, "INVALID_RESULT", "ComfyUI 返回的视频格式无效"))?;
        let destination = root.join(format!("{id}.{extension}"));
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .await?;
        file.write_all(&header).await?;
        let mut length = header.len() as u64;
        drop(header);
        if let Some(bytes) = remainder {
            length += bytes.len() as u64;
            file.write_all(&bytes).await?;
        }
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|_| ApiError::new(502, "COMFY_RESULT_ERROR", "ComfyUI 视频响应中断"))?;
            length = length.saturating_add(chunk.len() as u64);
            if length > MAX_BYTES {
                return Err(ApiError::new(
                    502,
                    "INVALID_RESULT",
                    "ComfyUI 返回的视频超过大小限制",
                ));
            }
            file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        drop(file);
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "视频读取已取消"));
        }
        tokio::fs::rename(&pending, &destination).await?;
        if !tokio::fs::canonicalize(&destination)
            .await?
            .starts_with(&canonical_root)
        {
            return Err(ApiError::new(
                500,
                "VIDEO_STORAGE_INVALID",
                "视频运行时目录无效",
            ));
        }
        Ok(Output::File {
            path: destination,
            mime: mime.into(),
            bytes: length,
        })
    };
    let result = tokio::select! {result=tokio::time::timeout(Duration::from_secs(120),transfer)=>match result{Ok(value)=>value,Err(_)=>Err(ApiError::new(504,"COMFY_TIMEOUT","视频读取超时"))},_=cancel.cancelled()=>Err(ApiError::new(499,"CANCELLED","视频读取已取消"))};
    if result.is_err() {
        let _ = tokio::fs::remove_file(pending).await;
    }
    result
}
