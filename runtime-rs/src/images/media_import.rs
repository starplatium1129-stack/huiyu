use super::*;
use crate::{host::OwnedWriteGuard, storage::Storage, task_contract::ResultRef};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceImage {
    source: WorkspaceSource,
    alias: String,
    sha256: String,
    bytes: u64,
}
#[derive(serde::Deserialize)]
enum WorkspaceSource {
    #[serde(rename = "workspace")]
    Workspace,
}

pub(crate) struct Destination {
    pub root: PathBuf,
    pub owner: String,
    pub limits: Limits,
    pub kind: ImageKind,
}

impl Service {
    pub(crate) async fn studio_reference(
        &self,
        storage: Storage,
        principal: &str,
        frame: &Value,
    ) -> Result<String> {
        if !self.native || self.is_remote() {
            return Err(ApiError::new(
                409,
                "NATIVE_VIDEO_REQUIRED",
                "项目补帧需要本机原生绘图",
            ));
        }
        frozen_frame(
            storage,
            principal,
            frame,
            Destination {
                root: inputs::root(&self.config, true),
                owner: principal.into(),
                limits: self.limits,
                kind: ImageKind::Anima,
            },
            self.shutdown.child_token(),
        )
        .await
    }
    pub(crate) async fn import_workspace(
        &self,
        storage: Storage,
        principal: String,
        input: WorkspaceImage,
        owner: String,
        admission: OwnedWriteGuard,
    ) -> Result<Value> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        let WorkspaceImage {
            source: WorkspaceSource::Workspace,
            alias,
            sha256,
            bytes,
        } = input;
        if alias.is_empty()
            || alias.len() > 256
            || alias.contains('\0')
            || sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || bytes == 0
            || bytes > ImageKind::Anima.maximum() as u64
        {
            return Err(error("INVALID_IMAGE", "原图来源信息无效"));
        }
        let scope = self.shutdown.child_token();
        let _guard = scope.clone().drop_guard();
        let target = Destination {
            root: inputs::root(&self.config, self.native),
            owner,
            limits: self.limits,
            kind: ImageKind::Anima,
        };
        let (reply, result) = tokio::sync::oneshot::channel();
        self.uploads.spawn(async move {
            let _admission = admission;
            let lease = uuid::Uuid::new_v4().to_string();
            let reference = storage
                .begin_workspace_media_import(&alias, &lease, &principal, Some((&sha256, bytes)))
                .await;
            let value = finish(storage, principal, lease, reference, target, scope).await;
            let _ = reply.send(value);
        });
        result
            .await
            .map_err(|_| ApiError::new(503, "IMAGE_SAVE_FAILED", "图片导入结果未知"))?
    }
}

pub(crate) async fn frozen_frame(
    storage: Storage,
    principal: &str,
    frame: &Value,
    target: Destination,
    scope: CancellationToken,
) -> Result<String> {
    let alias = frame["mediaAlias"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("帧图缺少工作区别名"))?;
    let hash = frame["sha256"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("帧图缺少摘要"))?;
    let bytes = frame["bytes"]
        .as_u64()
        .ok_or_else(|| ApiError::invalid("帧图缺少长度"))?;
    let lease = uuid::Uuid::new_v4().to_string();
    let reference = storage
        .begin_workspace_media_import(alias, &lease, principal, Some((hash, bytes)))
        .await;
    let result = finish(storage, principal.into(), lease, reference, target, scope).await?;
    result["name"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| ApiError::invalid("帧图导入未返回编号"))
}
pub(crate) async fn finish(
    storage: Storage,
    principal: String,
    lease: String,
    reference: Result<ResultRef>,
    target: Destination,
    scope: CancellationToken,
) -> Result<Value> {
    let imported = async {
        let reference = reference?;
        if scope.is_cancelled() {
            return Err(inputs::cancelled());
        }
        let accepted = if matches!(target.kind, ImageKind::StudioAudio) {
            reference.mime == "audio/wav"
        } else {
            matches!(reference.mime.as_str(), "image/png" | "image/jpeg" | "image/webp")
        };
        if !accepted || reference.bytes == 0
            || reference.bytes > target.kind.maximum() as u64
        {
            return Err(error("INVALID_MEDIA", "素材格式或大小与所选槽位不符"));
        }
        let media = storage.media(&reference.alias).await?;
        if reference.sha256 != media.sha256
            || reference.bytes != media.total_bytes
            || reference.mime != media.mime
        {
            return Err(ApiError::new(409, "MEDIA_INVALID", "图片元数据已改变"));
        }
        if scope.is_cancelled() {
            return Err(inputs::cancelled());
        }
        let bytes = media.total_bytes;
        let name = store_media_for(
            target.root,
            media,
            target.owner,
            target.limits,
            scope,
            target.kind,
        )
        .await?;
        Ok(json!({"ok":true,"name":name,"bytes":bytes}))
    }
    .await;
    // A begin reply can be lost after its transaction commits. Always release
    // this worker's lease, including cancellation and failed begin results.
    let cleanup = storage.end_task_result_import(&lease, &principal).await;
    match (imported, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), cleanup) => {
            if let Err(cleanup) = cleanup {
                eprintln!("image import lease cleanup: {cleanup}");
            }
            Err(error)
        }
    }
}
