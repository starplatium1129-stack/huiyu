use super::*;
use std::path::{Path, PathBuf};
use tokio::sync::Semaphore;
mod worker;

pub(super) struct Exports {
    slots: Semaphore,
    jobs: Mutex<HashMap<String, CancellationToken>>,
}
impl Default for Exports {
    fn default() -> Self {
        Self {
            slots: Semaphore::new(1),
            jobs: Mutex::default(),
        }
    }
}
impl Exports {
    pub(super) fn close(&self) {
        self.slots.close();
        for cancel in self.jobs.lock().unwrap().values() {
            cancel.cancel();
        }
    }
}
impl TaskRuntime {
    pub(crate) fn wake_exports(self: &Arc<Self>, storage: Storage, owner: String) {
        if self.check_running().is_err() {
            return;
        }
        let runtime = self.clone();
        self.tracker.spawn(async move {
            let jobs = match storage
                .request(json!({"kind":"studio.exportPending"}), &owner)
                .await
            {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("studio exports: {error}");
                    return;
                }
            };
            let mut active = runtime.exports.jobs.lock().unwrap();
            for job in jobs.as_array().into_iter().flatten() {
                let Some(id) = job["id"].as_str() else {
                    continue;
                };
                let key = identity(&storage, id);
                if let Some(token) = active.get(&key) {
                    if job["cancelRequested"] == true {
                        token.cancel();
                    }
                    continue;
                }
                let token = runtime.shutdown.child_token();
                active.insert(key.clone(), token.clone());
                let (storage, owner, runtime, job) =
                    (storage.clone(), owner.clone(), runtime.clone(), job.clone());
                runtime.clone().tracker.spawn(async move {
                    if let Err(e) = runtime.drive_export(&storage, &owner, &job, &token).await {
                        eprintln!("studio export {}: {e}", job["id"]);
                    }
                    runtime.exports.jobs.lock().unwrap().remove(&key);
                });
            }
        });
    }
    async fn drive_export(
        &self,
        storage: &Storage,
        owner: &str,
        job: &Value,
        token: &CancellationToken,
    ) -> Result<()> {
        let id = text(job, "id")?;
        let finish = |state: &str, msg: &str| json!({"kind":"studio.exportFinish","id":id,"status":state,"message":msg});
        // Only the process which changed queued -> running owns the encoder. A
        // restarted process can adopt an already committed MP4, never a partial file.
        if job["status"] == "running" {
            storage
                .request(
                    finish("interrupted", "上次导出已中断，可用这些镜头重新导出。"),
                    owner,
                )
                .await?;
            return Ok(());
        }
        let _slot = tokio::select! {
            _ = token.cancelled() => return Ok(()),
            permit = self.exports.slots.acquire() => match permit { Ok(p) => p, Err(_) => return Ok(()) },
        };
        if self.check_running().is_err() {
            return Ok(());
        }
        let job = storage
            .request(json!({"kind":"studio.exportStart","id":id}), owner)
            .await?;
        if job["status"] != "running" {
            return Ok(());
        }
        let result = self.compose(storage, owner, &job, token).await;
        let command = match result {
            Ok(()) => finish("succeeded", "成片已保存"),
            Err(e) if token.is_cancelled() || self.check_running().is_err() => {
                finish("interrupted", &e.message)
            }
            Err(e) => finish("failed", &e.message.chars().take(900).collect::<String>()),
        };
        storage.request(command, owner).await?;
        Ok(())
    }
    async fn compose(
        &self,
        storage: &Storage,
        owner: &str,
        job: &Value,
        token: &CancellationToken,
    ) -> Result<()> {
        let dir = tempfile::Builder::new().prefix("huiyu-export-").tempdir()?;
        let output = dir.path().join("movie.mp4");
        let settings = self.provider.native_settings()?;
        let python = settings
            .standalone_python()
            .ok_or_else(|| ApiError::invalid("请先在模型管理中安装本地原生运行环境"))?;
        let script = settings.worker.with_file_name("studio_export.py");
        let id = text(job, "id")?;
        let mut shots = Vec::new();
        for (i, source) in job["_inputs"]
            .as_array()
            .ok_or_else(|| ApiError::invalid("缺少冻结的导出原件"))?
            .iter()
            .enumerate()
        {
            let suffix = if source["video"]["mime"] == "video/webm" {
                "webm"
            } else {
                "mp4"
            };
            let video = copy_input(
                storage,
                &source["video"],
                dir.path().join(format!("{i}.{suffix}")),
                token,
            )
            .await?;
            let mut shot = json!({"videoPath":video});
            if !source["audio"].is_null() {
                shot["audioPath"] = json!(
                    copy_input(
                        storage,
                        &source["audio"],
                        dir.path().join(format!("{i}.wav")),
                        token
                    )
                    .await?
                );
            }
            shots.push(shot);
        }
        let request = json!({"op":"compose","id":id,"shots":shots,"options":job["options"],"outputPath":output,"modelsRoot":settings.models_root});
        let facts = worker::compose(storage, owner, token, &request, &python, &script).await?;
        if token.is_cancelled() {
            return Err(cancelled());
        }
        storage.request(json!({"kind":"studio.exportProgress","id":id,"message":"正在保存成片原件","progress":0.99,"metadata":facts}),owner).await?;
        // Once publication starts, finish the atomic media commit. The storage
        // transaction resolves a concurrent cancel before attaching any new clip.
        storage
            .publish_studio_movie(output, text(job, "_publication")?, owner, &facts)
            .await
    }
}
fn cancelled() -> ApiError {
    ApiError::new(499, "EXPORT_CANCELLED", "本次导出已停止")
}
async fn copy_input(
    storage: &Storage,
    source: &Value,
    path: PathBuf,
    token: &CancellationToken,
) -> Result<PathBuf> {
    tokio::select! {
        _ = token.cancelled() => Err(cancelled()),
        result = async {
            let alias = text(source,"mediaAlias")?;
            let mut original = storage.open_media(alias).await?;
            if source["sha256"] != original.media.sha256 || source["bytes"] != original.media.total_bytes || source["mime"] != original.media.mime {
                return Err(ApiError::invalid("镜头原件与提交导出时的版本不符"));
            }
            let mut target = tokio::fs::File::create_new(&path).await?;
            let length = tokio::io::copy(&mut original.file,&mut target).await?;
            if length != original.media.total_bytes { return Err(ApiError::invalid("镜头原件读取不完整")); }
            tokio::io::AsyncWriteExt::flush(&mut target).await?;
            drop(target);
            storage.finish_media(alias,original).await?;
            Ok(path)
        } => result,
    }
}
