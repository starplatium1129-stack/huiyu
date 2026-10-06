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

#[derive(Clone, Deserialize)]
pub(super) struct ModelFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
// Metadata is checked before open, and Unix open stays nonblocking if a
// concurrent replacement turns this fixed model path into a FIFO or symlink.
fn open_regular(path: &Path) -> std::io::Result<File> {
    if !std::fs::symlink_metadata(path)?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Expected a regular model file",
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Model path changed type",
        ));
    }
    Ok(file)
}

fn same_file_at(path: &Path, identity: &crate::file_identity::Identity) -> bool {
    // Reuse the cross-platform identity authority, but reopen through the
    // nonblocking regular-file guard rather than allowing a replacement FIFO.
    open_regular(path)
        .and_then(|current| crate::file_identity::opened(&current))
        .is_ok_and(|current| current == *identity)
}

impl ControlService {
    pub(super) fn verify_setup_model(self: &Arc<Self>, id: String) -> Result<Response> {
        let spec = model_file(&id)?;
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
        let root = model_root(&self.config.ai_workspace_root, &id)?;
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

pub(super) fn model_file(id: &str) -> Result<ModelFile> {
    Ok(serde_json::from_value(model_source(id)?)?)
}

pub(super) fn model_source(id: &str) -> Result<Value> {
    let manifest: Value = serde_json::from_str(include_str!("setup-models.json"))?;
    manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == id)
        .cloned()
        .ok_or_else(|| ApiError::invalid("只可操作绘遇已登记的模型和运行包"))
}

pub(super) fn model_root(workspace: &Path, id: &str) -> Result<PathBuf> {
    let source = model_source(id)?;
    Ok(workspace.join(match source["kind"].as_str() {
        Some("chat") => "Chat/models",
        Some("runtime") => ".setup/packages",
        _ => "ComfyUI/models",
    }))
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

pub(super) fn inspect(
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
    let mut file = match open_regular(&real_path) {
        Ok(value) => value,
        Err(_) => return finish("unknown", None, None, "无法打开模型文件"),
    };
    let before = match file.metadata() {
        Ok(value) if value.is_file() => value,
        _ => return finish("unknown", None, None, "目标不是可读取的普通文件"),
    };
    let identity = match crate::file_identity::opened(&file) {
        Ok(value) => value,
        Err(_) => {
            return finish(
                "unknown",
                None,
                None,
                "无法确认文件身份，请检查文件系统支持",
            );
        }
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
        || !same_file_at(&current_path, &identity)
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
    #[test]
    fn replacement_with_preserved_metadata_is_not_the_verified_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("model.safetensors");
        std::fs::write(&path, b"original").unwrap();
        let opened = open_regular(&path).unwrap();
        let identity = crate::file_identity::opened(&opened).unwrap();
        let before = opened.metadata().unwrap();
        std::fs::rename(&path, temp.path().join("previous.safetensors")).unwrap();
        std::fs::write(&path, b"replaced").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(before.modified().unwrap()))
            .unwrap();
        let after = std::fs::metadata(&path).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        assert!(!same_file_at(&path, &identity));
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            std::fs::remove_file(&path).unwrap();
            let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            assert!(
                open_regular(&path).is_err(),
                "FIFO must be rejected before a blocking open"
            );
            assert!(!same_file_at(&path, &identity));
        }
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
