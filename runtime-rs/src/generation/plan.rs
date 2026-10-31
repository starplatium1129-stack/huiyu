use super::*;
use std::path::PathBuf;
mod optional_nodes;

/// The two real Comfy image providers share execution, while each compiler owns
/// its complete normalized input, exact graph, resource list and output scope.
pub(crate) struct ComfyPlan {
    pub input: Arc<Value>,
    pub workflow: Value,
    pub metadata: Value,
    pub resources: Vec<PathBuf>,
    pub family: &'static str,
    pub namespace: &'static str,
    pub route_base: &'static str,
    pub output_prefix: &'static str,
    pub media_kind: MediaKind,
    pub output_node: &'static str,
    pub timeout: Duration,
    pub retention: Duration,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaKind {
    Image,
    Video,
}
pub(super) enum Execution {
    Webui(Box<Input>),
    Comfy(Box<ComfyPlan>),
    Native(Box<native::Plan>),
}
impl Execution {
    pub fn input(&self) -> Arc<Value> {
        match self {
            Self::Webui(input) => serde_json::to_value(input)
                .expect("validated input is JSON")
                .into(),
            Self::Comfy(plan) => plan.input.clone(),
            Self::Native(plan) => plan.input.clone(),
        }
    }
    pub fn route_base(&self) -> &str {
        match self {
            Self::Webui(_) => "/api/generation",
            Self::Comfy(plan) => plan.route_base,
            Self::Native(plan) if plan.input["mediaKind"] == "video" => "/api/video",
            Self::Native(plan) => match plan.input["family"].as_str() {
                Some("krea2") => "/api/creative",
                Some("qwen-image") => "/api/qwen",
                Some("moss-image") => "/api/moss",
                Some("manga-screen") => "/api/manga",
                Some("wan2.2") => "/api/video",
                _ => "/api/anima",
            },
        }
    }
}
pub(super) fn wai(input: Input, config: &Config) -> Result<ComfyPlan> {
    let root = config.ai_workspace_root.join("ComfyUI/models");
    let mut resources = vec![root.join("checkpoints").join(constants::CHECKPOINT)];
    resources.extend(input.loras.iter().map(|l| root.join("loras").join(&l.file)));
    Ok(ComfyPlan {
        workflow: workflow::build(&input)?,
        metadata: jobs::wai_metadata(&input, "comfy"),
        input: serde_json::to_value(&input)?.into(),
        resources,
        family: "sd",
        namespace: "wai",
        route_base: "/api/generation",
        output_prefix: "wai_app",
        media_kind: MediaKind::Image,
        output_node: "10",
        timeout: Duration::from_secs(10 * 60),
        retention: Duration::from_secs(30 * 60),
    })
}
impl Service {
    pub(crate) fn for_images(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
    ) -> Result<Self> {
        Self::with_scope(config, transport, shutdown, Scope::Images, None)
    }
    pub(crate) fn for_video(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
        native_engine: Arc<native::Engine>,
    ) -> Result<Self> {
        Self::with_scope(
            config,
            transport,
            shutdown,
            Scope::Video,
            Some(native_engine),
        )
    }
    pub(crate) async fn prepare_comfy(
        &self,
        plan: ComfyPlan,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        if self.inner.closed.load(Ordering::Relaxed) || self.inner.cancel.is_cancelled() {
            return Err(closed());
        }
        let permit = self
            .inner
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| match self.inner.scope {
                Scope::Video => {
                    ApiError::new(429, "VIDEO_QUEUE_FULL", "视频队列已满，请等待当前任务完成")
                }
                _ => ApiError::new(429, "ANIMA_QUEUE_FULL", "Anima 队列已满，请稍后再试"),
            })?;
        let work = async {
            for file in &plan.resources {
                if !tokio::fs::metadata(file).await.is_ok_and(|m| m.is_file()) {
                    return Err(ApiError::new(
                        503,
                        if matches!(self.inner.scope, Scope::Video) {
                            "VIDEO_MODEL_UNAVAILABLE"
                        } else {
                            "ANIMA_RESOURCE_UNAVAILABLE"
                        },
                        "所选生成模型或输入资源不可用",
                    ));
                }
            }
            let gpu = self.inner.native.comfy_handoff().await?;
            let control = self.inner.control.read().unwrap().upgrade();
            if let Some(control) = control {
                control.ensure_comfy(&cancel).await?;
            } else if !probe::comfy_status(&self.inner, &cancel).await {
                return Err(ApiError::new(503, "COMFY_UNAVAILABLE", "ComfyUI 不可用"));
            }
            if optional_nodes::requested(&plan.workflow) {
                let nodes =
                    optional_nodes::status(&self.inner, &cancel, Some(&plan.workflow)).await;
                optional_nodes::validate(&plan.workflow, &nodes)?;
            }
            Ok(Prepared {
                input: plan.input.as_ref().clone(),
                provider: "comfy".into(),
                execution: Execution::Comfy(Box::new(plan)),
                selected: "comfy",
                permit,
                gpu: Some(gpu),
            })
        };
        tokio::select! {result=work=>result,_=cancel.cancelled()=>Err(ApiError::new(499,"ABORT_ERR","生成请求已取消")),_=self.inner.cancel.cancelled()=>Err(closed())}
    }
    pub(crate) async fn comfy_optional_status(&self) -> Value {
        optional_nodes::status(&self.inner, &self.inner.cancel, None).await
    }
    pub(crate) async fn comfy_online(&self) -> bool {
        probe::comfy_status(&self.inner, &self.inner.cancel).await
    }
    pub(crate) fn pending(&self) -> usize {
        if self.inner.native_images {
            return self.inner.native.pending();
        }
        self.inner.scope.capacity() - self.inner.admission.available_permits()
    }
    pub(crate) async fn family_allowed(&self, id: &str, owner: &str, family: &str) -> Result<()> {
        snapshots::initialize(self.inner.clone()).await?;
        let state = self.inner.state.lock().await;
        let current = state
            .jobs
            .get(id)
            .filter(|j| j.owner == owner)
            .and_then(|j| j.input["family"].as_str());
        let lost = state
            .lost
            .get(id)
            .filter(|j| j.owner == owner)
            .and_then(|j| j.family.as_deref());
        if current.or(lost) == Some(family) {
            Ok(())
        } else {
            Err(ApiError::new(404, "JOB_NOT_FOUND", "生成任务不存在"))
        }
    }
}
