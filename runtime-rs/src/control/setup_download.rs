use super::setup_verify::{ModelFile, inspect, model_file, model_root, model_source};
use super::*;
#[path = "setup_transfer.rs"]
mod transfer;
use axum::{
    body::{Body, Bytes},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::{convert::Infallible, path::PathBuf};
use tokio::{io::AsyncWriteExt, sync::mpsc::Sender};

#[cfg(test)]
#[path = "setup_download_tests.rs"]
mod tests;

const PROGRESS_BUFFER: usize = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DownloadRequest {
    workspace_path: String,
    reviewed: bool,
}

struct DownloadPlan {
    workspace: PathBuf,
    root: PathBuf,
    spec: ModelFile,
    url: String,
    id: String,
}

impl ControlService {
    pub(super) fn download_setup_model(
        self: &Arc<Self>,
        id: String,
        body: DownloadRequest,
    ) -> Result<Response> {
        let spec = model_file(&id)?;
        if !body.reviewed || body.workspace_path != self.config.ai_workspace_root.to_string_lossy()
        {
            return Err(ApiError::new(
                409,
                "WORKSPACE_CHANGED",
                "请先核对当前运行时工作区和来源许可，再显式下载",
            ));
        }
        let source = model_source(&id)?;
        let url = source["sourceUrl"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "https://huggingface.co/{}/resolve/{}/{}",
                    source["repo"].as_str().unwrap(),
                    source["revision"].as_str().unwrap(),
                    source["remotePath"].as_str().unwrap()
                )
            });
        let permit = self
            .setup_verify_lock
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ApiError::new(
                    409,
                    "SETUP_BUSY",
                    "已有模型下载或校验在进行，请完成或取消后重试",
                )
            })?;
        let cancel = self.shutdown.child_token();
        let guard = cancel.clone().drop_guard();
        let (send, receive) = tokio::sync::mpsc::channel(PROGRESS_BUFFER);
        let (finished, completion) = tokio::sync::oneshot::channel();
        let plan = DownloadPlan {
            workspace: self.config.ai_workspace_root.clone(),
            root: model_root(&self.config.ai_workspace_root, &id)?,
            spec,
            url,
            id,
        };
        self.tasks.spawn(async move {
            let _permit = permit;
            let worker_cancel = cancel.child_token();
            let client = reqwest::Client::builder()
                .https_only(true)
                .connect_timeout(Duration::from_secs(30))
                .build();
            let outcome = match client {
                Ok(client) => {
                    let operation = download(&plan, &client, &send, &worker_cancel);
                    tokio::pin!(operation);
                    match tokio::time::timeout(Duration::from_secs(4 * 60 * 60), &mut operation)
                        .await
                    {
                        Ok(result) => result,
                        Err(_) => {
                            worker_cancel.cancel();
                            // Let cooperative cancellation retain resumable bytes, but do
                            // not turn the deadline into an unbounded wait on a stalled disk.
                            let _ = tokio::time::timeout(Duration::from_secs(5), operation).await;
                            Err(ApiError::new(
                                504,
                                "DOWNLOAD_TIMEOUT",
                                "下载超过 4 小时，已停止，请检查网络后重试",
                            ))
                        }
                    }
                }
                Err(_) => Err(ApiError::new(
                    500,
                    "DOWNLOAD_FAILED",
                    "无法建立模型下载连接",
                )),
            };
            let event = outcome.unwrap_or_else(|error| {
                result(
                    &plan,
                    "failed",
                    None,
                    None,
                    Some(&error.code),
                    &error.message,
                )
            });
            if !cancel.is_cancelled() && !send.is_closed() {
                let _ = finished.send(event);
            }
        });
        // Progress is lossy when a client falls behind; the final result has its own
        // slot, so it never blocks the worker or disappears behind a full progress queue.
        let stream = futures_util::stream::unfold(
            (receive, Some(completion), guard),
            |(mut receive, mut result, guard)| async move {
                let value = match receive.recv().await {
                    Some(value) => value,
                    None => result.take()?.await.ok()?,
                };
                let mut bytes = serde_json::to_vec(&value).unwrap();
                bytes.push(b'\n');
                Some((
                    Ok::<_, Infallible>(Bytes::from(bytes)),
                    (receive, result, guard),
                ))
            },
        );
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

fn stopped(cancel: &CancellationToken, send: &Sender<Value>) -> Result<()> {
    if cancel.is_cancelled() || send.is_closed() {
        Err(ApiError::new(409, "CANCELLED", "下载已取消，已有模型保留"))
    } else {
        Ok(())
    }
}
fn io_error(error: std::io::Error) -> ApiError {
    if matches!(error.raw_os_error(), Some(28 | 112)) {
        ApiError::new(409, "ENOSPC", "目标盘剩余空间不足，已有模型保留")
    } else {
        ApiError::new(
            500,
            "MODEL_IO",
            "无法写入模型目录，请检查本机权限和磁盘后重试",
        )
    }
}
fn changed() -> ApiError {
    ApiError::new(
        409,
        "WORKSPACE_CHANGED",
        "下载期间工作区或模型目录改变，已停止；请重新检查",
    )
}
fn progress(plan: &DownloadPlan, send: &Sender<Value>, phase: &str, bytes: u64) {
    let _ = send.try_send(json!({"type":"progress","modelId":plan.id,"phase":phase,"bytesRead":bytes,"expectedBytes":plan.spec.bytes}));
}
fn result(
    plan: &DownloadPlan,
    state: &str,
    bytes: Option<u64>,
    hash: Option<&str>,
    code: Option<&str>,
    message: &str,
) -> Value {
    json!({"type":"result","modelId":plan.id,"path":plan.root.join(&plan.spec.path),"state":state,
        "bytes":bytes,"sha256":hash,"code":code,"checkedAt":now(),"message":message})
}

async fn inspect_file(
    plan: &DownloadPlan,
    root: PathBuf,
    spec: ModelFile,
    phase: &str,
    send: &Sender<Value>,
    cancel: &CancellationToken,
) -> Result<Value> {
    progress(plan, send, phase, 0);
    let (events, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let id = plan.id.clone();
    let token = cancel.clone();
    let mut worker =
        tokio::task::spawn_blocking(move || inspect(&root, &spec, &id, &events, &token));
    let inspected = loop {
        tokio::select! {
            value = &mut worker => break value.map_err(|_| changed())?,
            Some(event) = receive.recv() => { progress(plan, send, phase, event["bytesRead"].as_u64().unwrap_or(0)); }
        }
    };
    stopped(cancel, send)?;
    Ok(inspected)
}

async fn download(
    plan: &DownloadPlan,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
) -> Result<Value> {
    stopped(cancel, send)?;
    let root = plan.root.clone();
    let path = root.join(&plan.spec.path);
    let workspace = plan.workspace.clone();
    let parent = path.parent().unwrap().to_path_buf();
    let root_check = root.clone();
    let (real_workspace, real_root, real_parent) =
        tokio::task::spawn_blocking(move || -> Result<_> {
            std::fs::create_dir_all(&workspace).map_err(io_error)?;
            let real_workspace = workspace.canonicalize().map_err(io_error)?;
            if !real_workspace.is_dir() {
                return Err(changed());
            }
            std::fs::create_dir_all(&parent).map_err(io_error)?;
            let real_root = root_check.canonicalize().map_err(io_error)?;
            let real_parent = parent.canonicalize().map_err(io_error)?;
            if !real_parent.starts_with(&real_root) {
                return Err(changed());
            }
            Ok((real_workspace, real_root, real_parent))
        })
        .await
        .map_err(|_| changed())??;
    if tokio::fs::symlink_metadata(&path).await.is_ok() {
        let inspected = inspect_file(
            plan,
            root.clone(),
            plan.spec.clone(),
            "checking",
            send,
            cancel,
        )
        .await?;
        if inspected["state"] == "sha256-match" {
            return Ok(result(
                plan,
                "already-present",
                Some(plan.spec.bytes),
                Some(&plan.spec.sha256),
                None,
                "已有文件与固定大小及 SHA-256 一致；未下载、未运行模型",
            ));
        }
        return Err(ApiError::new(
            409,
            "MODEL_CONFLICT",
            "同名模型已存在，内容未匹配固定清单；请先核对并自行移走冲突文件，下载不会替换它",
        ));
    }
    let partial_path = real_parent.join(format!(".huiyu-{}.part", plan.spec.sha256));
    let retained = tokio::fs::metadata(&partial_path)
        .await
        .ok()
        .filter(|m| m.is_file() && m.len() <= plan.spec.bytes)
        .map(|m| m.len())
        .unwrap_or(0);
    let space_path = real_parent.clone();
    let needed = plan
        .spec
        .bytes
        .saturating_sub(retained)
        .saturating_add(65536);
    tokio::task::spawn_blocking(move || {
        crate::resources::check_available_space(&space_path, needed)
    })
    .await
    .map_err(|_| changed())?
    .map_err(|error| {
        ApiError::new(
            409,
            &error.code,
            if error.code == "ENOSPC" {
                "目标盘剩余空间不足，已有模型保留"
            } else {
                "无法检查目标盘剩余空间，请核对磁盘与本机权限"
            },
        )
    })?;
    stopped(cancel, send)?;
    let partial = partial_path.clone();
    let mut temporary = Some(
        tokio::task::spawn_blocking(move || -> std::io::Result<_> {
            if let Ok(meta) = std::fs::symlink_metadata(&partial)
                && !meta.is_file()
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "Partial download is not a regular file",
                ));
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true).write(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
            }
            let file = options.open(&partial)?;
            // Validate the opened object before writes or TempPath cleanup own it.
            // A resumable name can be a hard link to an unrelated existing file.
            if !file.metadata()?.is_file() || crate::file_identity::opened(&file)?.links != 1 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "Partial download must be an exclusively linked regular file",
                ));
            }
            Ok(tempfile::NamedTempFile::from_parts(
                file,
                tempfile::TempPath::try_from_path(partial)?,
            ))
        })
        .await
        .map_err(|_| changed())?
        .map_err(io_error)?,
    );
    let outcome = async {
        let pending = temporary.as_ref().unwrap();
        let mut output =
            tokio::fs::File::from_std(pending.as_file().try_clone().map_err(io_error)?);
        let transferred = transfer::write(plan, client, send, cancel, &mut output).await;
        // Tokio may have accepted bytes while its blocking write is still queued.
        // Drain that write before cancellation/error cleanup inspects and retains the file.
        let flushed = output.flush().await;
        let count = transferred?;
        flushed.map_err(io_error)?;
        if count != plan.spec.bytes {
            return Err(ApiError::new(
                502,
                "SIZE_MISMATCH",
                "下载不完整，未发布模型文件；请重试",
            ));
        }
        output.sync_all().await.map_err(io_error)?;
        drop(output);
        let temp_spec = ModelFile {
            path: temporary
                .as_ref()
                .unwrap()
                .path()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            ..plan.spec.clone()
        };
        let verified = inspect_file(
            plan,
            real_parent.clone(),
            temp_spec,
            "verifying",
            send,
            cancel,
        )
        .await?;
        if verified["state"] != "sha256-match" {
            return Err(ApiError::new(
                502,
                "HASH_MISMATCH",
                "下载临时文件与固定大小或 SHA-256 不符，未发布；请核对来源后重试",
            ));
        }
        stopped(cancel, send)?;
        let current_workspace = plan.workspace.clone();
        let current_parent = path.parent().unwrap().to_path_buf();
        let token = cancel.clone();
        let temporary = temporary.take().unwrap();
        tokio::task::spawn_blocking(move || -> Result<()> {
            if token.is_cancelled() {
                return Err(ApiError::new(409, "CANCELLED", "下载已取消"));
            }
            if current_workspace.canonicalize().ok().as_ref() != Some(&real_workspace)
                || root.canonicalize().ok().as_ref() != Some(&real_root)
                || current_parent.canonicalize().ok().as_ref() != Some(&real_parent)
            {
                return Err(changed());
            }
            // Same-directory, atomic no-clobber publication: a file appearing during
            // the download is a conflict, never an invitation to replace weights.
            if token.is_cancelled() {
                return Err(ApiError::new(409, "CANCELLED", "下载已取消"));
            }
            temporary.persist_noclobber(&path).map_err(|error| {
                if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                    ApiError::new(
                        409,
                        "MODEL_CONFLICT",
                        "下载期间出现同名文件，原文件保留；请核对冲突后重试",
                    )
                } else {
                    io_error(error.error)
                }
            })?;
            Ok(())
        })
        .await
        .map_err(|_| changed())??;
        Ok(result(
            plan,
            "downloaded",
            Some(count),
            Some(&plan.spec.sha256),
            None,
            "下载文件大小与 SHA-256 校验通过，已发布；请重新检查，尚未验证加载或出图",
        ))
    }
    .await;
    if outcome.as_ref().is_err_and(|error| {
        matches!(
            error.code.as_str(),
            "CANCELLED" | "DOWNLOAD_TIMEOUT" | "DOWNLOAD_FAILED"
        )
    }) && let Some(pending) = temporary.take()
        && pending
            .as_file()
            .metadata()
            .is_ok_and(|meta| meta.len() > 0)
    {
        let _ = pending.keep();
    }
    outcome
}
