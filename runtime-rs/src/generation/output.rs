use super::*;
use futures_util::StreamExt;
use regex::Regex;
use reqwest::Method;
use std::sync::LazyLock;
use tokio::io::AsyncWriteExt;
static FILENAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:png|jpe?g|webp)$").unwrap()
});
static DENIED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[-_.])(?:input|temp|annotation|annotations|hash)(?:[-_.]|$)").unwrap()
});
pub(super) fn decode(value: &str) -> Result<String> {
    let mut value = value.to_owned();
    for _ in 0..3 {
        let next = percent_encoding::percent_decode_str(&value)
            .decode_utf8()
            .map_err(|_| ApiError::new(400, "INVALID_RESULT", "结果路径编码无效"))?
            .into_owned();
        if next == value {
            break;
        }
        value = next;
    }
    Ok(value)
}
pub(super) async fn materialize(inner: &Inner, job: &Job, image: &Value) -> Result<Output> {
    let Execution::Comfy(plan) = &job.execution else {
        unreachable!("Comfy materializer owns Comfy plans")
    };
    materialize_scoped(inner, &job.id, plan.output_prefix, plan.namespace, image).await
}
pub(super) async fn materialize_scoped(
    inner: &Inner,
    id: &str,
    prefix: &str,
    namespace: &str,
    image: &Value,
) -> Result<Output> {
    let filename = decode(image["filename"].as_str().unwrap_or(""))?;
    let folder = decode(image["subfolder"].as_str().unwrap_or(""))?;
    if !image.is_object()
        || !image["type"]
            .as_str()
            .unwrap_or("output")
            .eq_ignore_ascii_case("output")
        || !folder.is_empty()
        || !FILENAME.is_match(&filename)
        || !filename
            .to_ascii_lowercase()
            .strip_prefix(prefix)
            .is_some_and(|tail| tail.starts_with(['_', '.', '-']))
        || DENIED.is_match(&filename)
        || filename.contains(['\\', '/', '\0'])
    {
        return Err(ApiError::new(
            400,
            "INVALID_RESULT",
            "结果路径不在应用允许范围内",
        ));
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("filename", &filename)
        .append_pair("type", "output")
        .finish();
    let timeout = Duration::from_secs(20);
    let request = inner.request(
        "comfy",
        Method::GET,
        &format!("/view?{query}"),
        None,
        timeout,
    )?;
    let transfer = async {
        let response = request
            .send()
            .await
            .map_err(|error| transport::network_error("comfy", error))?;
        let status = response.status().as_u16();
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if response
            .content_length()
            .is_some_and(|n| n > constants::MAX_IMAGE as u64)
        {
            return Err(transport::too_large("comfy"));
        }
        let mut stream = response.bytes_stream();
        let mut header = Vec::with_capacity(12);
        let mut remainder = None;
        let mut length = 0_usize;
        while header.len() < 12 {
            let Some(chunk) = stream.next().await else {
                break;
            };
            let chunk = chunk.map_err(|error| transport::network_error("comfy", error))?;
            length = length.saturating_add(chunk.len());
            if length > constants::MAX_IMAGE {
                return Err(transport::too_large("comfy"));
            }
            let count = (12 - header.len()).min(chunk.len());
            header.extend_from_slice(&chunk[..count]);
            if count < chunk.len() {
                remainder = Some(chunk.slice(count..));
            }
        }
        let extension = match mime.as_str() {
            "image/png" if header.starts_with(b"\x89PNG\r\n\x1a\n") => Some("png"),
            "image/jpeg" if header.starts_with(b"\xff\xd8\xff") => Some("jpg"),
            "image/webp" if header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP") => {
                Some("webp")
            }
            _ => None,
        };
        // raw used to finish its bounded read before checking status or format.
        // Drain rejected bodies without buffering to retain network/limit errors.
        let extension = if (200..300).contains(&status)
            && let Some(extension) = extension
        {
            extension
        } else {
            drop(remainder);
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| transport::network_error("comfy", error))?;
                length = length.saturating_add(chunk.len());
                if length > constants::MAX_IMAGE {
                    return Err(transport::too_large("comfy"));
                }
            }
            return Err(if !(200..300).contains(&status) {
                ApiError::new(502, "COMFY_RESULT_ERROR", "ComfyUI 图片读取失败")
            } else {
                ApiError::new(502, "INVALID_RESULT", "ComfyUI 返回的结果不是受支持的图片")
            });
        };
        let directory = inner.config.runtime_root.join("outputs").join(namespace);
        let path = directory.join(format!("{id}.{extension}"));
        let mut save = async {
            tokio::fs::create_dir_all(&directory).await?;
            let root = tokio::fs::canonicalize(&directory).await?;
            let (file, pending) = tempfile::Builder::new()
                .prefix(&format!("{id}."))
                .suffix(".tmp")
                .tempfile_in(&directory)?
                .into_parts();
            let mut file = tokio::fs::File::from_std(file);
            file.write_all(&header).await?;
            if let Some(bytes) = remainder {
                file.write_all(&bytes).await?;
            }
            Ok::<_, std::io::Error>((file, pending, root))
        }
        .await;
        drop(header);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| transport::network_error("comfy", error))?;
            length = length.saturating_add(chunk.len());
            if length > constants::MAX_IMAGE {
                return Err(transport::too_large("comfy"));
            }
            if let Ok((file, _, _)) = &mut save
                && let Err(error) = file.write_all(&chunk).await
            {
                // A disk failure reclaims the temp file, but upstream errors still
                // take priority until the same bounded response has completed.
                save = Err(error);
            }
        }
        let (file, pending, root) = save.map_err(save_error)?;
        Ok((file, pending, root, path, mime, length))
    };
    let (mut file, pending, root, path, mime, length) = tokio::select! {
        result = tokio::time::timeout(timeout, transfer) => result.map_err(|_| ApiError::new(504, "COMFY_TIMEOUT", "上游请求超时"))?,
        _ = inner.cancel.cancelled() => Err(ApiError::new(499, "ABORT_ERR", "上游请求已取消")),
    }?;
    // EOF ends the upstream timeout, as it did for raw. Finish any background
    // disk write and surface its error before publishing the result path.
    file.flush().await.map_err(save_error)?;
    drop(file);
    if inner.cancel.is_cancelled() {
        return Err(ApiError::new(499, "ABORT_ERR", "上游请求已取消"));
    }
    // TempPath also cleans up when the caller drops recovery mid-write.
    // Keep publication and return in one poll so cancellation cannot leave
    // a renamed output that was never handed to its owner.
    pending
        .persist(&path)
        .map_err(|error| save_error(error.error))?;
    let target = std::fs::canonicalize(&path).map_err(save_error)?;
    if !target.starts_with(root) {
        return Err(save_error(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "result escaped output directory",
        )));
    }
    Ok(Output::File {
        path,
        mime,
        bytes: length as u64,
    })
}
fn save_error(_: std::io::Error) -> ApiError {
    ApiError::new(
        507,
        "RESULT_SAVE_FAILED",
        "生成图片保存失败，请检查本地磁盘空间和目录写入权限",
    )
}

#[cfg(test)]
mod tests;
