use super::*;
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
fn decode(value: &str) -> Result<String> {
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
    let (status, mime, bytes) = inner
        .raw(
            "comfy",
            Method::GET,
            &format!("/view?{query}"),
            None,
            transport::Bounds {
                timeout: Duration::from_secs(20),
                max_bytes: constants::MAX_IMAGE,
            },
            &inner.cancel,
        )
        .await?;
    if !(200..300).contains(&status) {
        return Err(ApiError::new(
            502,
            "COMFY_RESULT_ERROR",
            "ComfyUI 图片读取失败",
        ));
    }
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let extension = match mime.as_str() {
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
        "image/jpeg" if bytes.starts_with(b"\xff\xd8\xff") => "jpg",
        "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => "webp",
        _ => {
            return Err(ApiError::new(
                502,
                "INVALID_RESULT",
                "ComfyUI 返回的结果不是受支持的图片",
            ));
        }
    };
    let directory = inner.config.runtime_root.join("outputs").join(namespace);
    tokio::fs::create_dir_all(&directory).await?;
    let path = directory.join(format!("{id}.{extension}"));
    let save = async {
        let root = tokio::fs::canonicalize(&directory).await?;
        let (file, pending) = tempfile::Builder::new()
            .prefix(&format!("{id}."))
            .suffix(".tmp")
            .tempfile_in(&directory)?
            .into_parts();
        let mut file = tokio::fs::File::from_std(file);
        file.write_all(&bytes).await?;
        // Tokio may still be writing in the background; finish and surface any
        // write error before publishing the path to result collection.
        file.flush().await?;
        drop(file);
        // TempPath also cleans up when the caller drops recovery mid-write.
        // Keep publication and return in one poll so cancellation cannot leave
        // a renamed output that was never handed to its owner.
        pending.persist(&path).map_err(|error| error.error)?;
        let target = std::fs::canonicalize(&path)?;
        if !target.starts_with(root) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "result escaped output directory",
            ));
        }
        Ok::<_, std::io::Error>(())
    }
    .await;
    if save.is_err() {
        return Err(ApiError::new(
            507,
            "RESULT_SAVE_FAILED",
            "生成图片保存失败，请检查本地磁盘空间和目录写入权限",
        ));
    }
    Ok(Output::File {
        path,
        mime,
        bytes: bytes.len() as u64,
    })
}
