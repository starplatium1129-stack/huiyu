use super::*;
use crate::{host::OwnedWriteGuard, storage::Storage};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceInput {
    source: WorkspaceSource,
    alias: String,
    sha256: String,
    bytes: u64,
    mime: String,
}
#[derive(serde::Deserialize)]
enum WorkspaceSource {
    #[serde(rename = "workspace")]
    Workspace,
}

impl InterrogateService {
    pub(crate) async fn interrogate_workspace(
        &self,
        storage: Storage,
        principal: String,
        input: WorkspaceInput,
        admission: OwnedWriteGuard,
    ) -> Result<Value> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        let WorkspaceInput {
            source: WorkspaceSource::Workspace,
            alias,
            sha256,
            bytes,
            mime,
        } = input;
        if alias.is_empty()
            || alias.len() > 256
            || alias.contains('\0')
            || sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp")
            || bytes < 1024
        {
            return Err(ApiError::new(400, "INVALID_IMAGE", "参考图片来源信息无效"));
        }
        if bytes > MAX_BYTES as u64 {
            return Err(ApiError::new(413, "IMAGE_TOO_LARGE", "图片超过 20MB 限制"));
        }
        let scope = self.shutdown.child_token();
        let _guard = scope.clone().drop_guard();
        let (reply, result) = tokio::sync::oneshot::channel();
        {
            let closed_state = self.media_closed.lock().unwrap();
            if *closed_state {
                return Err(closed());
            }
            self.media_jobs.spawn(async move {
                let _admission = admission;
                let lease = uuid::Uuid::new_v4().to_string();
                let prepared = async {
                    let permit = crate::images::upload_body::admit(&scope).await?;
                    let reference = storage
                        .begin_workspace_media_import(
                            &alias,
                            &lease,
                            &principal,
                            Some((&sha256, bytes)),
                        )
                        .await?;
                    if scope.is_cancelled() {
                        return Err(cancelled());
                    }
                    let media = storage.media(&reference.alias).await?;
                    if reference.sha256 != media.sha256
                        || reference.bytes != media.total_bytes
                        || reference.mime != media.mime
                        || mime != media.mime
                    {
                        return Err(ApiError::new(
                            409,
                            "MEDIA_INVALID",
                            "参考图片来源已改变，请重新发送",
                        ));
                    }
                    // Await the bounded reader/hash worker even after cancellation:
                    // its full buffer must retain upload capacity until it exits.
                    let image = crate::images::read_media(media, MAX_BYTES, &scope).await?;
                    if scope.is_cancelled() {
                        return Err(cancelled());
                    }
                    Ok((Bytes::from(image), permit))
                }
                .await;
                // The prepared bytes are now private. End the lease before GPU
                // inference, including failed/uncertain begin replies.
                let cleanup = storage.end_task_result_import(&lease, &principal).await;
                let value = match (prepared, cleanup) {
                    (Ok(value), Ok(())) => Ok(value),
                    (Ok(_), Err(error)) => Err(error),
                    (Err(error), cleanup) => {
                        if let Err(cleanup) = cleanup {
                            eprintln!("interrogate media lease cleanup: {cleanup}");
                        }
                        Err(error)
                    }
                };
                let _ = reply.send(value);
            });
        }
        let (image, permit) = result
            .await
            .map_err(|_| ApiError::new(503, "INTERROGATE_UNAVAILABLE", "参考图片读取未完成"))??;
        self.interrogate(json!({}), image, permit).await
    }
}

fn cancelled() -> ApiError {
    ApiError::new(499, "CANCELLED", "图片反推已取消")
}
