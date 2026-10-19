use super::*;
use tokio::sync::Mutex;
use tokio_util::task::TaskTracker;
pub struct Prepared {
    pub(super) backend: generation::Prepared,
    pub(super) originals: inputs::Captured,
}
impl Prepared {
    pub(crate) fn input(&self) -> &Value {
        &self.backend.input
    }
    pub(crate) fn provider(&self) -> &str {
        &self.backend.provider
    }
}
#[derive(serde::Deserialize)]
#[serde(untagged)]
pub(crate) enum MediaImport {
    Task(TaskMediaImport),
    Workspace(WorkspaceMediaImport),
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskMediaImport {
    pub task_id: String,
    pub index: u64,
    pub alias: String,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceMediaImport {
    source: WorkspaceSource,
    alias: String,
}
#[derive(serde::Deserialize)]
enum WorkspaceSource {
    #[serde(rename = "workspace")]
    Workspace,
}
pub struct Service {
    pub(super) backend: Arc<generation::Service>,
    pub(super) config: Config,
    pub(super) transport: LocalUpstream,
    pub(super) shutdown: CancellationToken,
    pub(super) tasks: TaskTracker,
    pub(super) requests: generation::receipts::Requests,
    pub(super) batches: batch::Registry,
    pub(super) transcode: transcode::Queue,
    t8: Mutex<(bool, Option<tokio::time::Instant>)>,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}
impl Service {
    pub(crate) fn provider_identity(&self, unbound_epoch: &str) -> Value {
        self.backend.provider_identity(unbound_epoch)
    }
    pub(crate) fn bind_control(&self, control: &Arc<crate::control::ControlService>) {
        self.backend.bind_control(control);
    }
    pub(crate) fn new(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
        native_engine: Arc<generation::native::Engine>,
    ) -> Result<Self> {
        let shutdown = shutdown.child_token();
        let backend = Arc::new(generation::Service::for_video(
            config.clone(),
            transport.clone(),
            shutdown.clone(),
            native_engine,
        )?);
        let tasks = TaskTracker::new();
        let batches = Arc::new(Mutex::new(std::collections::HashMap::new()));
        batch::reap(batches.clone(), config.clone(), shutdown.clone(), &tasks);
        let requests = generation::receipts::Requests::new(config.runtime_root.join("jobs/video-requests"), "VIDEO", "视频");
        Ok(Self {
            backend,
            config,
            transport,
            shutdown,
            tasks,
            requests,
            batches,
            transcode: transcode::Queue::new(),
            t8: Mutex::new((false, None)),
        })
    }
    pub(super) async fn t8(&self, cancel: &CancellationToken) -> bool {
        let mut cache = self.t8.lock().await;
        if cache
            .1
            .is_some_and(|t| t.elapsed() < Duration::from_secs(60))
        {
            return cache.0;
        }
        let available = self
            .transport
            .json(
                &self.config.comfy_host,
                "/object_info/MiniMaxH3DualClockSamplerT8",
                None,
                Duration::from_secs(5),
                1024 * 1024,
                cancel,
            )
            .await
            .is_ok_and(|(status, value)| {
                (200..300).contains(&status)
                    && value.is_ok_and(|v| v.get("MiniMaxH3DualClockSamplerT8").is_some())
            });
        // Publish only completed probes. Dropped/cancelled requests must not
        // poison subsequent status reads or generation preparation.
        if !cancel.is_cancelled() {
            *cache = (available, Some(tokio::time::Instant::now()));
        }
        available
    }
    pub async fn prepare(
        &self,
        raw: Value,
        local: bool,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        self.prepare_owned(raw, local, None, cancel).await
    }
    pub(super) async fn prepare_owned(
        &self,
        raw: Value,
        local: bool,
        owner: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        let size = if raw["aspectRatio"] == "original" {
            Some(inputs::size(&self.config, raw["image"].as_str().unwrap_or("")).await?)
        } else {
            None
        };
        let input = if self.backend.native_enabled() { native::validate(&raw, size)? }
            else { validation::validate(&raw, size)? };
        drop(raw);
        self.prepare_input(input, local, owner, false, cancel).await
    }
    pub(super) async fn prepare_input(
        &self,
        input: Value,
        local: bool,
        owner: Option<&str>,
        batch: bool,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        if self.shutdown.is_cancelled() {
            return Err(error(503, "SERVICE_CLOSED", "生成服务已关闭"));
        }
        if self.backend.native_enabled() {
            let permit = self.backend.reserve_native(&cancel)?;
            let input = native::normalize(input)?;
            let originals = inputs::capture(&self.config, &input, local, owner, &cancel).await?;
            let plan = generation::native::adapters::plan(&self.backend.native_settings()?, input, None).await?;
            let backend = self.backend.prepare_native(plan, permit, &cancel)?;
            return Ok(Prepared { backend, originals });
        }
        if input["inferenceEngine"] == "native" {
            return Err(error(409, "TASK_RESUME_UNSAFE", "视频任务引擎已改变，请重新创建任务"));
        }
        let t8 = self.t8(&cancel).await;
        let plan = resources::plan(&self.config, input, t8, batch)?;
        let backend = self.backend.prepare_comfy(plan, cancel.clone()).await?;
        let originals =
            inputs::capture(&self.config, &backend.input, local, owner, &cancel).await?;
        Ok(Prepared {
            backend,
            originals,
        })
    }
    pub async fn submit(
        self: Arc<Self>,
        prepared: Prepared,
        owner: String,
        hooks: Option<Arc<dyn ExecutionHooks>>,
    ) -> Result<Value> {
        inputs::protect_restore(
            &self.config,
            &prepared.originals,
            hooks.as_deref(),
            &self.shutdown,
        )
        .await?;
        let job = self
            .backend
            .clone()
            .submit(prepared.backend, owner.clone(), hooks)
            .await?;
        let id = job["id"].as_str().unwrap().to_owned();
        drop(job);
        self.get_job(&id, &owner).await
    }
    pub async fn get_job(&self, id: &str, owner: &str) -> Result<Value> {
        let mut job = self.backend.get_job(id, owner).await?;
        for key in [
            "width",
            "height",
            "duration",
            "fps",
            "estimatedSeconds",
            "originalPrompt",
        ] {
            job[key] = job["metadata"][key].clone();
        }
        job["prompt"] = job["metadata"]["originalPrompt"].clone();
        if job["provider"] == "native" {
            // Keep worker step progress; Comfy's elapsed-time estimate is not
            // evidence of native sampling progress or expected performance.
            return Ok(job);
        }
        if job["status"] == "running" {
            job["progress"] = json!(
                (job["elapsedSeconds"].as_f64().unwrap_or(0.)
                    / job["estimatedSeconds"].as_f64().unwrap_or(1.))
                .clamp(0.02, 0.9)
            );
        } else {
            job["progress"] = json!(if job["status"] == "succeeded" { 1. } else { 0. });
        }
        Ok(job)
    }
    pub async fn query(&self, id: &str, owner: &str) -> Result<Observation> {
        self.backend.query(id, owner).await
    }
    pub async fn result(&self, id: &str, owner: &str) -> Result<Output> {
        self.backend.result(id, owner).await
    }
    pub async fn cancel(&self, id: &str, owner: &str) -> Result<Value> {
        self.backend.cancel(id, owner).await?;
        self.get_job(id, owner).await
    }
    pub(crate) async fn upload(
        &self,
        data: axum::body::Bytes,
        owner: String,
        reference: bool,
        cancel: CancellationToken,
        admission: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<String> {
        let scope = self.shutdown.child_token();
        let _guard = scope.clone().drop_guard();
        let root = self.config.ai_workspace_root.join("ComfyUI/input");
        let (reply, result) = tokio::sync::oneshot::channel();
        self.tasks.spawn(async move {
            let _admission = admission;
            let value = crate::images::store_for(
                root,
                data,
                owner,
                crate::images::Limits::from_environment(),
                scope,
                if reference {
                    crate::images::ImageKind::VideoReference
                } else {
                    crate::images::ImageKind::VideoInput
                },
            )
            .await;
            let _ = reply.send(value);
        });
        tokio::select! {result=result=>result.map_err(|_|error(503,"IMAGE_WRITE_FAILED","图片写入结果未知"))?,_=cancel.cancelled()=>Err(error(499,"CANCELLED","图片上传已取消"))}
    }
    pub(crate) async fn import_result(
        &self,
        storage: crate::storage::Storage,
        principal: String,
        source: MediaImport,
        owner: String,
        admission: crate::host::OwnedWriteGuard,
    ) -> Result<Value> {
        let scope = self.shutdown.child_token();
        let _guard = scope.clone().drop_guard();
        let root = self.config.ai_workspace_root.join("ComfyUI/input");
        let (reply, result) = tokio::sync::oneshot::channel();
        self.tasks.spawn(async move {
            let _admission = admission;
            let lease = uuid::Uuid::new_v4().to_string();
            let reference = async {
                Ok(match source {
                    MediaImport::Task(source) => storage
                        .begin_task_result_import(
                            &source.task_id,
                            source.index,
                            &source.alias,
                            &lease,
                            &principal,
                        )
                        .await?
                        .reference
                        .ok_or_else(|| error(404, "TASK_RESULT_MISSING", "任务图片不存在"))?,
                    MediaImport::Workspace(WorkspaceMediaImport {
                        source: WorkspaceSource::Workspace,
                        alias,
                    }) => {
                        storage
                            .begin_workspace_media_import(&alias, &lease, &principal, None)
                            .await?
                    }
                })
            }
            .await;
            let target = crate::images::media_import::Destination {
                root,
                owner,
                limits: crate::images::Limits::from_environment(),
                kind: crate::images::ImageKind::VideoInput,
            };
            let value = crate::images::media_import::finish(
                storage, principal, lease, reference, target, scope,
            )
            .await;
            let _ = reply.send(value);
        });
        result
            .await
            .map_err(|_| error(503, "IMAGE_WRITE_FAILED", "图片导入结果未知"))?
    }
    pub async fn get_status(&self) -> Result<Value> {
        if self.backend.native_enabled() {
            return native::status(&self.backend).await;
        }
        // One filesystem job per poll, alongside the existing network probes.
        // Every request still inspects the current model files.
        let root = self.config.ai_workspace_root.join("ComfyUI/models");
        let (models, t8, online) = tokio::join!(
            tokio::task::spawn_blocking(move || resources::local_models(root)),
            self.t8(&self.shutdown),
            self.backend.comfy_online(),
        );
        let models = models
            .map_err(|_| error(503, "VIDEO_STATUS_UNAVAILABLE", "视频资源状态暂不可用"))?;
        let qualities = catalog::constants()["QUALITIES"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, q)| {
                let sizes = q["sizes"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(id, s)| {
                        (
                            id.clone(),
                            json!(format!("{} × {}", s["width"], s["height"])),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>();
                json!({"id":id,"label":q["label"],"summary":q["summary"],"sizes":sizes})
            })
            .collect::<Vec<_>>();
        let acceleration_reason = if !online {
            "ComfyUI 未连接，T8 加速状态待检测"
        } else if t8 {
            "已检测到 T8 双时钟采样节点；使用前仍需准备模型和加速权重，实际速度取决于设备"
        } else {
            "当前未检测到 T8 双时钟节点，使用原生采样器；实际速度取决于模型和设备"
        };
        let mut value = json!({"online":online,"pending":self.backend.pending(),"maxPending":2,"models":null,"qualities":null,"defaults":{"modelId":"wan2.2-ti2v-5b","aspectRatio":"landscape","duration":3,"camera":"still","motion":"subtle","quality":"standard"},"t8":{"available":online && t8,"reason":acceleration_reason}});
        value["models"] = Value::Array(models);
        value["qualities"] = Value::Array(qualities);
        Ok(value)
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        self.requests.wait_for_acceptance().await;
        self.transcode.close().await;
        self.tasks.close();
        self.tasks.wait().await;
        self.backend.close().await;
    }
}
