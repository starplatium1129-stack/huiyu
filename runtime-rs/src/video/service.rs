use super::*;
use tokio::sync::Mutex;
use tokio_util::task::TaskTracker;
pub struct Prepared {
    pub input: Value,
    pub provider: String,
    pub(super) backend: generation::Prepared,
    pub(super) originals: inputs::Captured,
}
pub struct Service {
    pub(super) backend: Arc<generation::Service>,
    pub(super) config: Config,
    pub(super) transport: LocalUpstream,
    pub(super) shutdown: CancellationToken,
    pub(super) tasks: TaskTracker,
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
    pub fn new(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
    ) -> Result<Self> {
        Self::with_transcoder(
            config,
            transport,
            shutdown,
            Arc::new(transcode::Ffmpeg::default()),
        )
    }
    pub fn with_transcoder(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
        runner: Arc<dyn Transcoder>,
    ) -> Result<Self> {
        let shutdown = shutdown.child_token();
        let backend = Arc::new(generation::Service::for_video(
            config.clone(),
            transport.clone(),
            shutdown.clone(),
        )?);
        let tasks = TaskTracker::new();
        let batches = Arc::new(Mutex::new(std::collections::HashMap::new()));
        batch::reap(batches.clone(), config.clone(), shutdown.clone(), &tasks);
        Ok(Self {
            backend,
            config,
            transport,
            shutdown,
            tasks,
            batches,
            transcode: transcode::Queue::new(runner),
            t8: Mutex::new((false, None)),
        })
    }
    pub(super) async fn t8(&self, cancel: &CancellationToken) -> bool {
        let mut cache = self.t8.lock().await;
        if cache.0
            || cache
                .1
                .is_some_and(|t| t.elapsed() < Duration::from_secs(60))
        {
            return cache.0;
        }
        cache.1 = Some(tokio::time::Instant::now());
        cache.0 = self
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
        cache.0
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
        let input = validation::validate(&raw, local, size)?;
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
        let t8 = self.t8(&cancel).await;
        let plan = resources::plan(&self.config, input, t8, batch)?;
        let backend = self.backend.prepare_comfy(plan, cancel.clone()).await?;
        let originals =
            inputs::capture(&self.config, &backend.input, local, owner, &cancel).await?;
        Ok(Prepared {
            input: backend.input.clone(),
            provider: backend.provider.clone(),
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
        self.get_job(job["id"].as_str().unwrap(), &owner).await
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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        job["elapsedSeconds"] = json!(
            ((now - job["createdAt"].as_i64().unwrap_or(now)).max(0) as f64 / 1000.).round() as u64
        );
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
    pub async fn upload(
        &self,
        data: String,
        owner: String,
        reference: bool,
        cancel: CancellationToken,
    ) -> Result<String> {
        let scope = self.shutdown.child_token();
        let _guard = scope.clone().drop_guard();
        let root = self.config.ai_workspace_root.join("ComfyUI/input");
        let (reply, result) = tokio::sync::oneshot::channel();
        self.tasks.spawn(async move {
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
    pub async fn get_status(&self) -> Result<Value> {
        let mut models = Vec::new();
        for model in catalog::constants()["MODEL_CATALOG"].as_array().unwrap() {
            models.push(resources::available(&self.config, model).await);
        }
        let t8 = self.t8(&self.shutdown).await;
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
        Ok(
            json!({"online":self.backend.comfy_online().await,"pending":self.backend.pending(),"maxPending":2,"models":models,"qualities":qualities,"defaults":{"modelId":"wan2.2-ti2v-5b","aspectRatio":"landscape","duration":3,"camera":"still","motion":"subtle","quality":"standard"},"t8":{"available":t8,"reason":if t8{"T8 双时钟采样 + 4 步加速 LoRA（最快路径）"}else{"已降级：原生采样器（速度约慢 1 倍）；提交任务时会自动重新探测"}}}),
        )
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        self.transcode.close().await;
        self.tasks.close();
        self.tasks.wait().await;
        self.backend.close().await;
    }
}
