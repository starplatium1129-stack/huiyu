use super::super::setup_verify::{model_file, model_root, model_source};
use super::*;
use axum::{
    body::{Body, Bytes},
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
};

const MAX_FILES: usize = 12;
const DOWNLOAD_CONCURRENCY: usize = 2;
const PROGRESS_BUFFER: usize = 48;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::control) struct DownloadRequest {
    workspace_path: String,
    reviewed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::control) struct BatchDownloadRequest {
    workspace_path: String,
    reviewed: bool,
    model_ids: Vec<String>,
}

impl ControlService {
    pub(in crate::control) fn download_setup_model(
        self: &Arc<Self>,
        id: String,
        body: DownloadRequest,
    ) -> Result<Response> {
        self.setup_download_stream(vec![id], body.workspace_path, body.reviewed, false)
    }

    pub(in crate::control) fn download_setup_batch(
        self: &Arc<Self>,
        body: BatchDownloadRequest,
    ) -> Result<Response> {
        self.setup_download_stream(body.model_ids, body.workspace_path, body.reviewed, true)
    }

    fn setup_download_stream(
        self: &Arc<Self>,
        ids: Vec<String>,
        workspace_path: String,
        reviewed: bool,
        batch: bool,
    ) -> Result<Response> {
        let workspace = &self.config.ai_workspace_root;
        if !reviewed || workspace_path != workspace.to_string_lossy() {
            return Err(ApiError::new(
                409,
                "WORKSPACE_CHANGED",
                "请先核对当前运行时工作区和来源许可，再显式下载",
            ));
        }
        if ids.is_empty() || ids.len() > MAX_FILES {
            return Err(ApiError::invalid("模型下载批次大小无效"));
        }
        let mut hashes = HashSet::new();
        let mut plans = Vec::with_capacity(ids.len());
        for id in ids {
            let spec = model_file(&id)?;
            // Staging paths are keyed by hash, including under aliased model roots.
            if !hashes.insert(spec.sha256.clone()) {
                return Err(ApiError::invalid("模型下载批次包含重复文件"));
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
            plans.push(DownloadPlan {
                workspace: workspace.clone(),
                root: model_root(workspace, &id)?,
                spec,
                url,
                id,
                allow_mirror: true,
                parallel_ranges: true,
                #[cfg(windows)]
                archive_checks: Some(self.setup_archives.clone()),
            });
        }
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
        let client = crate::http_client::tune_proxy(reqwest::Client::builder())
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| ApiError::new(500, "DOWNLOAD_FAILED", "无法建立模型下载连接"))?;
        let cancel = self.shutdown.child_token();
        let guard = cancel.clone().drop_guard();
        let (send, receive) = tokio::sync::mpsc::channel(PROGRESS_BUFFER);
        let (finish, finished) = tokio::sync::oneshot::channel();
        self.tasks.spawn(async move {
            let (plans, concurrency) = if plans.len() > 1 {
                match tokio::task::spawn_blocking(move || {
                    let concurrency = if fits_in_parallel(&plans) == Some(true) {
                        DOWNLOAD_CONCURRENCY
                    } else {
                        1
                    };
                    (plans, concurrency)
                })
                .await
                {
                    Ok(value) => value,
                    Err(_) => return,
                }
            } else {
                (plans, 1)
            };
            let mut jobs = stream::iter(plans)
                .map(|plan| download_result(plan, &client, &send, &cancel))
                .buffer_unordered(concurrency);
            let mut last = None;
            while let Some(event) = jobs.next().await {
                if cancel.is_cancelled() {
                    // Pending writes own resumable files until cancellation has drained.
                    continue;
                }
                if batch {
                    tokio::select! {
                        _ = cancel.cancelled() => {},
                        _ = send.send(event) => {},
                    }
                } else {
                    last = Some(event);
                }
            }
            drop(jobs);
            drop(permit);
            if !cancel.is_cancelled() {
                let _ = finish.send(if batch {
                    json!({"type":"complete"})
                } else {
                    last.unwrap()
                });
            }
        });
        // Completion has its own slot. The worker releases ownership before the client
        // can start the next batch, while file results arrive as soon as they settle.
        let stream = stream::unfold(
            (receive, Some(finished), guard),
            |(mut receive, mut finished, guard)| async move {
                let value = match receive.recv().await {
                    Some(value) => value,
                    None => finished.take()?.await.ok()?,
                };
                let mut bytes = serde_json::to_vec(&value).unwrap();
                bytes.push(b'\n');
                Some((
                    Ok::<_, Infallible>(Bytes::from(bytes)),
                    (receive, finished, guard),
                ))
            },
        );
        let mut response = Body::from_stream(stream).into_response();
        let headers = response.headers_mut();
        headers.insert(
            "content-type",
            "application/x-ndjson; charset=utf-8".parse().unwrap(),
        );
        headers.insert("cache-control", "no-store".parse().unwrap());
        headers.insert("x-accel-buffering", "no".parse().unwrap());
        Ok(response)
    }
}

fn fits_in_parallel(plans: &[DownloadPlan]) -> Option<bool> {
    let mut remaining_by_volume = HashMap::new();
    for plan in plans {
        let target = plan.root.join(&plan.spec.path);
        if target.symlink_metadata().is_ok() {
            continue;
        }
        let parent = target.parent()?;
        let existing = parent.ancestors().find(|path| path.is_dir())?;
        let volume = file_identity::path(existing, true).ok()?.dev;
        let available = match remaining_by_volume.entry(volume) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(crate::resources::available_space(existing).ok()?)
            }
        };
        let partial = parent.join(format!(".huiyu-{}.part", plan.spec.sha256));
        let retained = partial
            .symlink_metadata()
            .ok()
            .filter(|metadata| metadata.is_file() && metadata.len() <= plan.spec.bytes)
            .map_or(0, |metadata| metadata.len());
        let needed = (plan.spec.bytes - retained).saturating_add(65536);
        // Keep the existing per-file disk check. When the whole batch cannot fit,
        // serializing gives the first file a chance to finish before space runs out.
        *available = match available.checked_sub(needed) {
            Some(remaining) => remaining,
            None => return Some(false),
        };
    }
    Some(true)
}

async fn download_result(
    plan: DownloadPlan,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
) -> Value {
    let worker_cancel = cancel.child_token();
    let operation = download(&plan, client, send, &worker_cancel);
    tokio::pin!(operation);
    let outcome = match tokio::time::timeout(Duration::from_secs(4 * 60 * 60), &mut operation).await
    {
        Ok(result) => result,
        Err(_) => {
            worker_cancel.cancel();
            // Let cooperative cancellation flush buffered bytes before releasing ownership.
            let _ = tokio::time::timeout(Duration::from_secs(5), operation).await;
            Err(ApiError::new(
                504,
                "DOWNLOAD_TIMEOUT",
                "下载超过 4 小时，已停止，请检查网络后重试",
            ))
        }
    };
    outcome.unwrap_or_else(|error| {
        result(
            &plan,
            "failed",
            None,
            None,
            Some(&error.code),
            &error.message,
        )
    })
}
