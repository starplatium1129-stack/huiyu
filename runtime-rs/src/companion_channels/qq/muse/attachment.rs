use super::*;
use crate::companion_channels::media::IMAGE_LIMIT;
use axum::body::Bytes;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

pub(super) const NENE_COMMAND: &str = "/发图 宁宁";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EncodedFile {
    mime_type: String,
    data: String,
}

pub(super) const AUDIO_LIMIT: usize = 3 * 1024 * 1024;

pub(super) struct Attachment {
    pub(super) kind: MediaKind,
    name: &'static str,
    pub(super) bytes: Bytes,
}

impl EncodedFile {
    pub(super) fn decode(self, kind: MediaKind) -> Result<Attachment> {
        let (limit, size_code, base64_code, label) = match kind {
            MediaKind::Image => (IMAGE_LIMIT, "QQ_MUSE_IMAGE_SIZE", "INVALID_REQUEST", "图片"),
            MediaKind::Audio => (
                AUDIO_LIMIT,
                "QQ_MUSE_AUDIO_SIZE",
                "QQ_MUSE_AUDIO_BASE64",
                "语音",
            ),
        };
        let too_large = || ApiError::new(413, size_code, format!("{label}最多 3 MiB"));
        if self.data.len() > limit.div_ceil(3) * 4 {
            return Err(too_large());
        }
        let bytes = STANDARD.decode(self.data).map(Bytes::from).map_err(|_| {
            ApiError::new(
                400,
                base64_code,
                format!("{label} data 需要原文件的标准 Base64"),
            )
        })?;
        if bytes.len() > limit {
            return Err(too_large());
        }
        match kind {
            MediaKind::Image => Attachment::image(&self.mime_type, bytes),
            MediaKind::Audio
                if self.mime_type.eq_ignore_ascii_case("audio/mpeg") && mp3_frame(&bytes) =>
            {
                Ok(Attachment {
                    kind,
                    name: "muse.mp3",
                    bytes,
                })
            }
            MediaKind::Audio => Err(ApiError::new(
                415,
                "QQ_MUSE_AUDIO_TYPE",
                "请上传 MP3 文件，并使用 audio/mpeg",
            )),
        }
    }
}

// An ID3 tag alone is not audio. Skip ID3v2 metadata, then check for an MPEG Layer III frame.
fn mp3_frame(mut bytes: &[u8]) -> bool {
    while bytes.starts_with(b"ID3") {
        let Some(header) = bytes.get(..10) else {
            return false;
        };
        if !(2..=4).contains(&header[3]) || header[6..10].iter().any(|b| b & 0x80 != 0) {
            return false;
        }
        let size = header[6..10]
            .iter()
            .fold(0usize, |n, b| (n << 7) + usize::from(*b));
        let footer = header[3] == 4 && header[5] & 0x10 != 0;
        let Some(rest) = bytes.get(10 + size + usize::from(footer) * 10..) else {
            return false;
        };
        bytes = rest;
    }
    let [0xff, flags, rates, _, _, ..] = *bytes else {
        return false;
    };
    flags & 0xe0 == 0xe0
        && (flags >> 3) & 3 != 1
        && (flags >> 1) & 3 == 1
        && rates >> 4 != 15
        && (rates >> 2) & 3 != 3
}

impl Attachment {
    pub(super) fn image(mime: &str, bytes: Bytes) -> Result<Self> {
        if bytes.len() > IMAGE_LIMIT {
            return Err(ApiError::new(413, "QQ_MUSE_IMAGE_SIZE", "图片最多 3 MiB"));
        }
        let name = match (mime, crate::image_decode::sniff(&bytes)) {
            ("image/jpeg", Some(("image/jpeg", _))) => "muse.jpg",
            ("image/png", Some(("image/png", _))) => "muse.png",
            _ => {
                return Err(ApiError::new(
                    415,
                    "QQ_MUSE_IMAGE_TYPE",
                    "请上传 JPEG 或 PNG 文件，并指定相符的 MIME 类型",
                ));
            }
        };
        Ok(Self {
            kind: MediaKind::Image,
            name,
            bytes,
        })
    }

    pub(super) async fn upload(
        &self,
        mailbox: &Mailbox,
        destination: Destination<'_>,
    ) -> Result<String> {
        if self.kind == MediaKind::Image {
            crate::image_decode::validate(Arc::new(self.bytes.clone()), &mailbox.cancel).await?;
        }
        mailbox
            .api
            .upload_media(destination, self.kind, self.name, &self.bytes)
            .await
    }
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

pub(super) struct MediaDelivery {
    kind: MediaKind,
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
        Attachment::image("image/jpeg", Bytes::from(bytes))?,
        selection,
    )
    .await
}

pub(super) async fn send(
    app: &AppState,
    mailbox: &Mailbox,
    entry: &Entry,
    attachment: Attachment,
    selection: Selection,
) -> Result<()> {
    let digest: [u8; 32] = Sha256::digest(&attachment.bytes).into();
    let mut delivery = entry.delivery.lock().await;
    let remaining = reply_window(app, mailbox, entry)?;
    if delivery.skipped {
        return Err(ApiError::new(409, "QQ_MUSE_SKIPPED", "此消息已经跳过"));
    }
    let target = entry.destination();
    let send = async {
        let media = match &mut delivery.media {
            Some(media)
                if selection == Selection::Exact
                    && (media.kind != attachment.kind || media.digest != digest) =>
            {
                return Err(ApiError::new(
                    409,
                    if media.kind == MediaKind::Image && attachment.kind == MediaKind::Image {
                        "QQ_MUSE_IMAGE_CONFLICT"
                    } else {
                        "QQ_MUSE_MEDIA_CONFLICT"
                    },
                    "这个问题已使用其他附件，重试请提交相同文件",
                ));
            }
            Some(media) => media,
            None => {
                let file_info = attachment.upload(mailbox, target).await?;
                delivery.media.insert(MediaDelivery {
                    kind: attachment.kind,
                    digest,
                    file_info,
                    attempted: false,
                    confirmed: false,
                })
            }
        };
        if !media.confirmed {
            reply_window(app, mailbox, entry)?;
            // Keep the same upload receipt and sequence after an ambiguous QQ send.
            let retry = std::mem::replace(&mut media.attempted, true);
            entry.send_attempted.store(true, Ordering::Relaxed);
            let result = mailbox
                .api
                .send(
                    target,
                    &entry.message_id,
                    3,
                    json!({"msg_type":7,"media":{"file_info":media.file_info}}),
                )
                .await;
            if let Err(error) = result
                && !(retry && error.code == "QQ_MESSAGE_DUPLICATE")
            {
                if error.submission_not_accepted || error.code == "QQ_MESSAGE_DUPLICATE" {
                    delivery.media = None;
                }
                return Err(error);
            }
            media.confirmed = true;
            entry.trace(match media.kind {
                MediaKind::Image => "qq_image_confirmed",
                MediaKind::Audio => "qq_audio_confirmed",
            });
            return Ok(Some(media.kind));
        }
        Ok(None)
    };
    let confirmed = tokio::select! {
        biased;
        _ = mailbox.cancel.cancelled() => Err(expired()),
        result = tokio::time::timeout(remaining, send) => result.map_err(|_| expired())?,
    }?;
    if let Some(kind) = confirmed {
        mailbox
            .remember_sent(entry.scope, &entry.conversation_id, kind.name(), None)
            .await;
    }
    Ok(())
}
