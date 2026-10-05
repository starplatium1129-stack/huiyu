use super::setup_verify::{ModelFile, inspect, model_file};
use super::*;
use axum::{
    body::{Body, Bytes},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::{convert::Infallible, path::PathBuf};
use tokio::{io::AsyncWriteExt, sync::mpsc::UnboundedSender};

#[cfg(test)]
#[path = "setup_download_tests.rs"]
mod tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DownloadRequest {
    workspace_path: String,
    reviewed: bool,
}

struct DownloadPlan {
    workspace: PathBuf,
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
        let manifest: Value = serde_json::from_str(include_str!("setup-models.json"))?;
        let source = manifest["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == spec.path)
            .unwrap();
        let url = format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            source["repo"].as_str().unwrap(),
            source["revision"].as_str().unwrap(),
            source["remotePath"].as_str().unwrap()
        );
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
        let (send, receive) = tokio::sync::mpsc::unbounded_channel();
        let plan = DownloadPlan {
            workspace: self.config.ai_workspace_root.clone(),
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
                Ok(client) => match tokio::time::timeout(
                    Duration::from_secs(4 * 60 * 60),
                    download(&plan, &client, &send, &worker_cancel),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => {
                        worker_cancel.cancel();
                        Err(ApiError::new(
                            504,
                            "DOWNLOAD_TIMEOUT",
                            "下载超过 4 小时，已停止，请检查网络后重试",
                        ))
                    }
                },
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
                let _ = send.send(event);
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

fn stopped(cancel: &CancellationToken, send: &UnboundedSender<Value>) -> Result<()> {
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
fn progress(plan: &DownloadPlan, send: &UnboundedSender<Value>, phase: &str, bytes: u64) {
    let _ = send.send(json!({"type":"progress","modelId":plan.id,"phase":phase,"bytesRead":bytes,"expectedBytes":plan.spec.bytes}));
}
fn result(
    plan: &DownloadPlan,
    state: &str,
    bytes: Option<u64>,
    hash: Option<&str>,
    code: Option<&str>,
    message: &str,
) -> Value {
    json!({"type":"result","modelId":plan.id,"path":plan.workspace.join("ComfyUI/models").join(&plan.spec.path),"state":state,
        "bytes":bytes,"sha256":hash,"code":code,"checkedAt":now(),"message":message})
}

async fn inspect_file(
    plan: &DownloadPlan,
    root: PathBuf,
    spec: ModelFile,
    phase: &str,
    send: &UnboundedSender<Value>,
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
    send: &UnboundedSender<Value>,
    cancel: &CancellationToken,
) -> Result<Value> {
    stopped(cancel, send)?;
    let root = plan.workspace.join("ComfyUI/models");
    let path = root.join(&plan.spec.path);
    let workspace = plan.workspace.clone();
    let parent = path.parent().unwrap().to_path_buf();
    let root_check = root.clone();
    let (real_workspace, real_root, real_parent) =
        tokio::task::spawn_blocking(move || -> Result<_> {
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
    let space_path = real_parent.clone();
    let needed = plan.spec.bytes.saturating_add(65536);
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
    let directory = real_parent.clone();
    let temporary = tokio::task::spawn_blocking(move || {
        tempfile::Builder::new()
            .prefix(".huiyu-model-")
            .suffix(".part")
            .tempfile_in(directory)
    })
    .await
    .map_err(|_| changed())?
    .map_err(io_error)?;
    let mut output = tokio::fs::File::from_std(temporary.as_file().try_clone().map_err(io_error)?);
    progress(plan, send, "downloading", 0);
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(ApiError::new(409,"CANCELLED","下载已取消")),
        response = tokio::time::timeout(Duration::from_secs(60), client.get(&plan.url).header("accept-encoding", "identity").send()) =>
            response.map_err(|_| ApiError::new(504,"DOWNLOAD_TIMEOUT","来源响应超时，请重试"))?.map_err(|_| ApiError::new(502,"DOWNLOAD_FAILED","无法连接固定模型来源，请检查网络后重试"))?,
    };
    if response.status() != reqwest::StatusCode::OK {
        return Err(ApiError::new(
            502,
            "DOWNLOAD_HTTP",
            format!(
                "固定来源返回 HTTP {}，请检查来源访问权限后重试",
                response.status().as_u16()
            ),
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size != plan.spec.bytes)
    {
        return Err(ApiError::new(
            502,
            "SIZE_MISMATCH",
            "来源文件大小与固定清单不符，已停止下载",
        ));
    }
    let mut stream = response.bytes_stream();
    let mut count = 0_u64;
    let mut last = Instant::now();
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Err(ApiError::new(409,"CANCELLED","下载已取消")),
            next = tokio::time::timeout(Duration::from_secs(60), stream.next()) => next.map_err(|_| ApiError::new(504,"DOWNLOAD_TIMEOUT","下载响应中断超过 60 秒，请重试"))?,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk
            .map_err(|_| ApiError::new(502, "DOWNLOAD_FAILED", "模型下载中断，请检查网络后重试"))?;
        stopped(cancel, send)?;
        count += chunk.len() as u64;
        if count > plan.spec.bytes {
            return Err(ApiError::new(
                502,
                "SIZE_MISMATCH",
                "下载字节超过固定大小，已停止",
            ));
        }
        output.write_all(&chunk).await.map_err(io_error)?;
        if last.elapsed() >= Duration::from_millis(250) || count == plan.spec.bytes {
            progress(plan, send, "downloading", count);
            last = Instant::now();
        }
    }
    if count != plan.spec.bytes {
        return Err(ApiError::new(
            502,
            "SIZE_MISMATCH",
            "下载不完整，未发布模型文件；请重试",
        ));
    }
    output.flush().await.map_err(io_error)?;
    output.sync_all().await.map_err(io_error)?;
    drop(output);
    let temp_spec = ModelFile {
        path: temporary
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
