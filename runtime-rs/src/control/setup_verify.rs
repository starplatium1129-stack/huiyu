use super::*;
use axum::{
    body::{Body, Bytes},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use tokio::sync::mpsc::UnboundedSender;

#[derive(Deserialize)]
struct ModelFile {
    path: String,
    bytes: u64,
    sha256: String,
}
#[derive(Deserialize)]
struct Manifest {
    files: Vec<ModelFile>,
}

impl ControlService {
    pub(super) fn verify_setup_model(self: &Arc<Self>, id: String) -> Result<Response> {
        let index = match id.as_str() {
            "anima-aesthetic-v1.1" => 0,
            "qwen-encoder" => 1,
            "qwen-vae" => 2,
            _ => return Err(ApiError::invalid("只可校验起步清单中的三个模型文件")),
        };
        let spec = serde_json::from_str::<Manifest>(include_str!("setup-models.json"))?
            .files
            .into_iter()
            .nth(index)
            .unwrap();
        let permit = self
            .setup_verify_lock
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ApiError::new(
                    409,
                    "VERIFICATION_BUSY",
                    "已有模型校验在进行，请先完成或取消",
                )
            })?;
        let root = self.config.ai_workspace_root.join("ComfyUI/models");
        let cancel = self.shutdown.child_token();
        let guard = cancel.clone().drop_guard();
        let (send, receive) = tokio::sync::mpsc::unbounded_channel();
        // One bounded-buffer worker for the whole runtime, including other
        // windows. Neither filesystem reads nor hashing run on an async worker.
        self.tasks.spawn_blocking(move || {
            let _permit = permit;
            let result = inspect(&root, &spec, &id, &send, &cancel);
            if !cancel.is_cancelled() && !send.is_closed() {
                let _ = send.send(result);
            }
        });
        let stream =
            futures_util::stream::unfold((receive, guard), |(mut receive, guard)| async move {
                let value = receive.recv().await?;
                let mut bytes = serde_json::to_vec(&value).unwrap();
                bytes.push(b'\n');
                Some((Ok::<_, Infallible>(Bytes::from(bytes)), (receive, guard)))
            });
        let mut response = Body::from_stream(stream).into_response();
        response.headers_mut().insert(
            "content-type",
            "application/x-ndjson; charset=utf-8".parse().unwrap(),
        );
        response
            .headers_mut()
            .insert("cache-control", "no-store".parse().unwrap());
        response
            .headers_mut()
            .insert("x-accel-buffering", "no".parse().unwrap());
        Ok(response)
    }
}

fn terminal(
    id: &str,
    path: &Path,
    state: &str,
    bytes: Option<u64>,
    hash: Option<String>,
    message: &str,
) -> Value {
    json!({"type":"result","modelId":id,"path":path,"state":state,"bytes":bytes,
        "sha256":hash,"checkedAt":now(),"message":message})
}

fn inspect(
    root: &Path,
    spec: &ModelFile,
    id: &str,
    send: &UnboundedSender<Value>,
    cancel: &CancellationToken,
) -> Value {
    let path = root.join(&spec.path);
    let finish = |state, bytes, hash, message| terminal(id, &path, state, bytes, hash, message);
    if cancel.is_cancelled() || send.is_closed() {
        return finish("unknown", None, None, "校验已取消");
    }
    let real_path = match path.canonicalize() {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return finish("missing", None, None, "未发现文件，请先放置后重新检查");
        }
        Err(_) => {
            return finish(
                "unknown",
                None,
                None,
                "无法读取模型路径，请检查文件访问权限",
            );
        }
    };
    // A shared models directory/junction is allowed, but an individual file
    // escaping that real model root is not a general-purpose file-hash API.
    let real_root = match root.canonicalize() {
        Ok(value) if real_path.starts_with(&value) => value,
        _ => {
            return finish(
                "unknown",
                None,
                None,
                "文件位于实际模型根目录之外，请核对目录映射",
            );
        }
    };
    let mut file = match File::open(&real_path) {
        Ok(value) => value,
        Err(_) => return finish("unknown", None, None, "无法打开模型文件"),
    };
    let before = match file.metadata() {
        Ok(value) if value.is_file() => value,
        _ => return finish("unknown", None, None, "目标不是可读取的普通文件"),
    };
    if before.len() != spec.bytes {
        return finish(
            "size-mismatch",
            Some(before.len()),
            None,
            "文件大小不符，未读取完整权重",
        );
    }
    let progress = |count| json!({"type":"progress","modelId":id,"bytesRead":count,"expectedBytes":spec.bytes});
    if send.send(progress(0)).is_err() {
        return finish("unknown", None, None, "校验已取消");
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut count = 0_u64;
    let mut next_progress = 64 * 1024 * 1024;
    let started = Instant::now();
    loop {
        if cancel.is_cancelled() || send.is_closed() {
            return finish("unknown", None, None, "校验已取消");
        }
        if started.elapsed() > Duration::from_secs(30 * 60) {
            return finish(
                "unknown",
                Some(count),
                None,
                "校验超过 30 分钟，已停止，请检查磁盘状态",
            );
        }
        let read = match file.read(&mut buffer) {
            Ok(value) => value,
            Err(_) => {
                return finish(
                    "unknown",
                    Some(count),
                    None,
                    "读取中断，请检查文件或磁盘后重试",
                );
            }
        };
        if read == 0 {
            break;
        }
        count += read as u64;
        if count > spec.bytes {
            return finish(
                "changed",
                Some(count),
                None,
                "校验期间文件改变，请等待下载或复制结束后重试",
            );
        }
        digest.update(&buffer[..read]);
        if count >= next_progress || count == spec.bytes {
            if send.send(progress(count)).is_err() {
                return finish("unknown", None, None, "校验已取消");
            }
            next_progress = count + 64 * 1024 * 1024;
        }
    }
    let unchanged = |meta: std::io::Result<std::fs::Metadata>| {
        meta.is_ok_and(|after| {
            after.is_file()
                && after.len() == before.len()
                && after.modified().ok() == before.modified().ok()
        })
    };
    let current_path = path.canonicalize().unwrap_or_else(|_| PathBuf::new());
    if count != spec.bytes
        || current_path != real_path
        || !current_path.starts_with(real_root)
        || !unchanged(file.metadata())
        || !unchanged(std::fs::metadata(&path))
    {
        return finish(
            "changed",
            Some(count),
            None,
            "校验期间文件或路径改变，请重新检查",
        );
    }
    let hash = hex::encode(digest.finalize());
    let matches = hash == spec.sha256;
    finish(
        if matches {
            "sha256-match"
        } else {
            "hash-mismatch"
        },
        Some(count),
        Some(hash),
        if matches {
            "本次读取的字节与固定发布摘要一致；尚未验证模型加载或出图"
        } else {
            "摘要不符，请核对来源与完整性；不要继续把此文件当作已验证模型"
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_hashing_distinguishes_integrity_and_never_rewrites_files() {
        let temp = tempfile::tempdir().unwrap();
        let data = b"synthetic weights";
        let path = temp.path().join("model.safetensors");
        let spec = ModelFile {
            path: "model.safetensors".into(),
            bytes: data.len() as u64,
            sha256: hex::encode(Sha256::digest(data)),
        };
        let (send, _receive) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        assert_eq!(
            inspect(temp.path(), &spec, "fixture", &send, &cancel)["state"],
            "missing"
        );
        std::fs::write(&path, data).unwrap();
        assert_eq!(
            inspect(temp.path(), &spec, "fixture", &send, &cancel)["state"],
            "sha256-match"
        );
        std::fs::write(&path, vec![0; data.len()]).unwrap();
        assert_eq!(
            inspect(temp.path(), &spec, "fixture", &send, &cancel)["state"],
            "hash-mismatch"
        );
        assert_eq!(std::fs::read(&path).unwrap(), vec![0; data.len()]);
        std::fs::write(&path, b"partial").unwrap();
        assert_eq!(
            inspect(temp.path(), &spec, "fixture", &send, &cancel)["state"],
            "size-mismatch"
        );
        cancel.cancel();
        assert_eq!(
            inspect(temp.path(), &spec, "fixture", &send, &cancel)["state"],
            "unknown"
        );
    }
    #[tokio::test]
    async fn verification_is_allowlisted_serialized_and_released_after_disconnect() {
        let (_temp, service) = super::super::tests::fixture(json!({}));
        assert!(service.verify_setup_model("../../secret".into()).is_err());
        let permit = service
            .setup_verify_lock
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        assert_eq!(
            service
                .verify_setup_model("qwen-vae".into())
                .unwrap_err()
                .code,
            "VERIFICATION_BUSY"
        );
        drop(permit);
        let response = service.verify_setup_model("qwen-vae".into()).unwrap();
        drop(response);
        let _released = tokio::time::timeout(
            Duration::from_secs(2),
            service.setup_verify_lock.clone().acquire_owned(),
        )
        .await
        .unwrap()
        .unwrap();
        service.close().await;
    }
}
