use super::*;
use crate::companion_channels::media::IMAGE_LIMIT;
use axum::body::Bytes;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

pub(super) const NENE_COMMAND: &str = "/发图 宁宁";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EncodedImage {
    mime_type: String,
    data: String,
}

impl EncodedImage {
    pub(super) fn decode(self) -> Result<(String, Bytes)> {
        if self.data.len() > IMAGE_LIMIT.div_ceil(3) * 4 {
            return Err(ApiError::new(413, "QQ_MUSE_IMAGE_SIZE", "图片最多 3 MiB"));
        }
        let bytes = STANDARD
            .decode(self.data)
            .map_err(|_| ApiError::invalid("图片 data 需要文件原始字节的标准 Base64"))?;
        image_name(&self.mime_type, &bytes)?;
        Ok((self.mime_type, Bytes::from(bytes)))
    }
}

fn image_name(mime: &str, bytes: &[u8]) -> Result<&'static str> {
    if bytes.len() > IMAGE_LIMIT {
        return Err(ApiError::new(413, "QQ_MUSE_IMAGE_SIZE", "图片最多 3 MiB"));
    }
    match (mime, crate::image_decode::sniff(bytes)) {
        ("image/jpeg", Some(("image/jpeg", _))) => Ok("muse.jpg"),
        ("image/png", Some(("image/png", _))) => Ok("muse.png"),
        _ => Err(ApiError::new(
            415,
            "QQ_MUSE_IMAGE_TYPE",
            "请上传 JPEG 或 PNG 文件，并指定相符的 MIME 类型",
        )),
    }
}

pub(super) async fn validate(
    mime: &str,
    bytes: &Bytes,
    cancel: &CancellationToken,
) -> Result<&'static str> {
    let name = image_name(mime, bytes)?;
    crate::image_decode::validate(Arc::new(bytes.clone()), cancel).await?;
    Ok(name)
}

pub(super) fn requests_nene_photo(text: &str, character: &str) -> bool {
    // Match an entire portrait request. A question discussing a photo, a negative
    // request, or a request with other conditions should remain entirely Muse's choice.
    let text = text
        .trim()
        .trim_end_matches(['。', '！', '？', '!', '?', '～', '~'])
        .trim_end();
    let text = text.strip_prefix("请").unwrap_or(text).trim_start();
    let Some(object) = ["发一张", "发张", "给我发一张", "给我发张"]
        .iter()
        .find_map(|verb| text.strip_prefix(*verb))
    else {
        return false;
    };
    let Some(who) = object
        .strip_suffix("的照片")
        .or_else(|| object.strip_suffix("的图片"))
    else {
        return false;
    };
    matches!(who, "宁宁" | "绫地宁宁" | "宁宁在窗边喝茶")
        || character == "nene" && matches!(who, "你" | "你在窗边喝茶")
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Selection {
    Exact,
    IfMissing,
}

pub(super) struct ImageDelivery {
    digest: [u8; 32],
    file_info: String,
    attempted: bool,
    pub(super) confirmed: bool,
}

pub(super) async fn send_nene(
    app: &AppState,
    mailbox: &Mailbox,
    entry: &Entry,
    selection: Selection,
) -> Result<()> {
    let file =
        tokio::fs::File::open(app.config.assets_root().join("characters/nene-home-cg.jpg")).await?;
    let mut bytes = Vec::new();
    file.take(IMAGE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    send(
        app,
        mailbox,
        entry,
        "image/jpeg",
        Bytes::from(bytes),
        selection,
    )
    .await
}

pub(super) async fn send(
    app: &AppState,
    mailbox: &Mailbox,
    entry: &Entry,
    mime: &str,
    bytes: Bytes,
    selection: Selection,
) -> Result<()> {
    let name = image_name(mime, &bytes)?;
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    let mut delivery = entry.delivery.lock().await;
    let remaining = reply_window(app, mailbox, entry)?;
    if delivery.skipped {
        return Err(ApiError::new(409, "QQ_MUSE_SKIPPED", "此消息已经跳过"));
    }
    let target = entry.destination();
    let send = async {
        let image = match &mut delivery.image {
            Some(image) if image.digest != digest && selection == Selection::Exact => {
                return Err(ApiError::new(
                    409,
                    "QQ_MUSE_IMAGE_CONFLICT",
                    "这个问题已使用另一张图片，重试请提交相同文件",
                ));
            }
            Some(image) => image,
            None => {
                crate::image_decode::validate(Arc::new(bytes.clone()), &mailbox.cancel).await?;
                let file_info = mailbox.api.image(target, name, &bytes).await?;
                delivery.image.insert(ImageDelivery {
                    digest,
                    file_info,
                    attempted: false,
                    confirmed: false,
                })
            }
        };
        if !image.confirmed {
            reply_window(app, mailbox, entry)?;
            // Keep the same upload receipt and sequence after an ambiguous QQ send.
            let retry = std::mem::replace(&mut image.attempted, true);
            let result = mailbox
                .api
                .send(
                    target,
                    &entry.message_id,
                    3,
                    json!({"msg_type":7,"media":{"file_info":image.file_info}}),
                )
                .await;
            if let Err(error) = result
                && !(retry && error.code == "QQ_MESSAGE_DUPLICATE")
            {
                if error.submission_not_accepted || error.code == "QQ_MESSAGE_DUPLICATE" {
                    delivery.image = None;
                }
                return Err(error);
            }
            image.confirmed = true;
            eprintln!("Muse 图片已获 QQ 确认");
        }
        Ok(())
    };
    tokio::select! {
        biased;
        _ = mailbox.cancel.cancelled() => Err(expired()),
        result = tokio::time::timeout(remaining, send) => result.map_err(|_| expired())?,
    }
}
