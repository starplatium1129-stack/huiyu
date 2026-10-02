use super::*;
use crate::execution::Output;
use crate::storage::{TaskMediaChunk, TaskMediaTarget};
use axum::body::Bytes;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
#[cfg(test)]
mod tests;

pub(super) enum Target {
    Input(String),
    Result(usize),
}
struct SharedOutput(Arc<Vec<u8>>);
impl AsRef<[u8]> for SharedOutput {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}
impl Target {
    fn command(&self, id: &str, phase: &str) -> Value {
        match self {
            Self::Input(name) => {
                json!({"kind":format!("task.input.{phase}"),"taskId":id,"name":name})
            }
            Self::Result(index) => {
                json!({"kind":format!("task.result.{phase}"),"taskId":id,"index":index})
            }
        }
    }
    fn alias(&self, id: &str) -> String {
        match self {
            Self::Input(name) => format!(
                "task-input-{}",
                hex::encode(Sha256::digest(format!("input:{id}:{name}").as_bytes()))
            ),
            Self::Result(index) => format!("task-{id}-{index}"),
        }
    }
}

pub(super) async fn persist(
    storage: &Storage,
    principal: &str,
    id: &str,
    target: Target,
    output: Output,
) -> Result<()> {
    let mut hash = Sha256::new();
    let mut file = if let Output::File { path, .. } = &output {
        Some(tokio::fs::File::open(path).await?)
    } else {
        None
    };
    if let Output::Bytes { bytes, .. } = &output {
        hash.update(bytes.as_slice());
    } else if let Some(file) = file.as_mut() {
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
        file.rewind().await?;
    }
    let mut media = json!({"alias":target.alias(id),"sha256":hex::encode(hash.finalize()),"bytes":output.len(),"mime":output.mime()});
    if let Target::Result(index) = &target {
        media["index"] = json!(index);
    }
    let mut prepare = target.command(id, "prepare");
    prepare["media"] = media;
    let prepared = storage.request(prepare, principal).await?;
    let mut offset = prepared["offset"]
        .as_u64()
        .filter(|v| *v <= output.len())
        .ok_or_else(|| {
            ApiError::new(503, "TASK_MEDIA_INVALID", "Invalid persisted media offset")
        })?;
    if let Some(file) = file.as_mut() {
        file.seek(std::io::SeekFrom::Start(offset)).await?;
    }
    let shared = match &output {
        Output::Bytes { bytes, .. } => Some(Bytes::from_owner(SharedOutput(bytes.clone()))),
        Output::File { .. } => None,
    };
    while offset < output.len() {
        let length = (output.len() - offset).min(1024 * 1024) as usize;
        let data = match &output {
            Output::Bytes { .. } => shared
                .as_ref()
                .unwrap()
                .slice(offset as usize..offset as usize + length),
            Output::File { .. } => {
                let mut buffer = vec![0; length];
                file.as_mut().unwrap().read_exact(&mut buffer).await?;
                Bytes::from(buffer)
            }
        };
        // This process already owns the bytes. Keep the JSON/base64 codec at
        // the HTTP boundary and transfer shared slices or owned file buffers.
        let result = storage
            .task_media_chunk(
                TaskMediaChunk {
                    task_id: id.into(),
                    target: match &target {
                        Target::Input(name) => TaskMediaTarget::Input(name.clone()),
                        Target::Result(index) => TaskMediaTarget::Result(*index as u64),
                    },
                    offset,
                    bytes: data,
                },
                principal,
            )
            .await?;
        offset = Some(result)
            .filter(|next| *next > offset && *next <= output.len())
            .ok_or_else(|| {
                ApiError::new(503, "TASK_MEDIA_INVALID", "Media upload did not advance")
            })?;
    }
    storage
        .request(target.command(id, "commit"), principal)
        .await?;
    Ok(())
}

pub(super) async fn restore(
    storage: &Storage,
    principal: &str,
    id: &str,
    name: &str,
    path: &Path,
) -> Result<bool> {
    let record = storage
        .request(
            json!({"kind":"task.input.get","taskId":id,"name":name}),
            principal,
        )
        .await?;
    if record.is_null() {
        return Ok(false);
    }
    let source = storage.media(text(&record, "alias")?).await?;
    if record["sha256"] != source.sha256 || record["bytes"] != source.total_bytes {
        return Err(ApiError::new(
            409,
            "TASK_INPUT_INVALID",
            "Frozen task input is inconsistent",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::invalid("Input destination has no parent"))?;
    tokio::fs::create_dir_all(parent).await?;
    let mut input = tokio::fs::File::open(&source.path).await?;
    let (output, pending) = tempfile::NamedTempFile::new_in(parent)?.into_parts();
    let mut output = tokio::fs::File::from_std(output);
    let bytes = tokio::io::copy(&mut input, &mut output).await?;
    if bytes != source.total_bytes {
        return Err(ApiError::new(
            409,
            "TASK_INPUT_INVALID",
            "Frozen task input copy was incomplete",
        ));
    }
    output.sync_all().await?;
    drop(output);
    pending
        .persist(path)
        .map_err(|error| ApiError::from(error.error))?;
    Ok(true)
}
