use super::*;

pub(super) enum ProviderRoute {
    Generation,
    Image(&'static str),
    Video,
    Batch,
}

impl From<TaskKind> for ProviderRoute {
    fn from(kind: TaskKind) -> Self {
        match kind {
            TaskKind::Generation => Self::Generation,
            TaskKind::Anima => Self::Image("anima"),
            TaskKind::Creative => Self::Image("krea2"),
            TaskKind::Qwen => Self::Image("qwen-image"),
            TaskKind::Moss => Self::Image("moss-image"),
            TaskKind::Manga | TaskKind::Lineart => Self::Image("manga-screen"),
            TaskKind::Video => Self::Video,
            TaskKind::Batch => Self::Batch,
        }
    }
}

pub(super) enum Preparation {
    Generation(crate::generation::Prepared),
    Image(crate::images::Prepared),
    Video(crate::video::Prepared),
    Batch(crate::video::BatchPrepared),
}
impl Preparation {
    pub(super) fn input(&self) -> &Value {
        match self {
            Self::Generation(p) => &p.input,
            Self::Image(p) => p.input(),
            Self::Video(p) => p.input(),
            Self::Batch(p) => &p.input,
        }
    }
    pub(super) fn provider(&self) -> &str {
        match self {
            Self::Generation(p) => p.provider(),
            Self::Image(p) => p.provider(),
            Self::Video(p) => p.provider(),
            Self::Batch(p) => p.provider(),
        }
    }
}
impl TaskRuntime {
    pub(super) fn recovered_remote_job<'a>(&self, task: &'a TaskRecord) -> Option<&'a str> {
        let ProviderRoute::Image(family) = ProviderRoute::from(task.kind) else {
            return None;
        };
        if task.provider != "native" || !self.images.is_remote() {
            return None;
        }
        let checkpoint = task.checkpoint.as_deref()?;
        if checkpoint["remoteFamily"].as_str() != Some(family) {
            return None;
        }
        let id = checkpoint["gatewayJobId"].as_str()?;
        if task.upstream_id.as_deref().is_some_and(|upstream| upstream != id) {
            return None;
        }
        Some(id)
    }

    /// Read the bound image job only. Step updates never write task revisions or
    /// change acceptance, recovery, cancellation or result collection state.
    pub async fn image_progress(
        &self,
        storage: &Storage,
        principal: &str,
        task: &Value,
    ) -> Option<Value> {
        if self.check_running().is_err()
            || task["status"] != "running"
            || task["recoveryState"] != "normal"
            || task["upstreamSettled"] == true
        {
            return None;
        }
        let kind = match task["kind"].as_str()? {
            "anima" => TaskKind::Anima,
            "creative" => TaskKind::Creative,
            _ => return None,
        };
        let ProviderRoute::Image(family) = ProviderRoute::from(kind) else {
            return None;
        };
        let id = task["taskId"].as_str()?;
        let binding = self.job(storage, id).filter(|job| !job.is_empty())?;
        let snapshot = self
            .images
            .get_job(&binding, principal, family)
            .await
            .ok()?;
        if snapshot["status"] != "running" || snapshot["unknown"] == true {
            return None;
        }
        Some(json!({
            "value":snapshot["progress"].as_f64().filter(|value| value.is_finite()).map(|value| value.clamp(0.,1.)),
            "message":snapshot["progressText"].as_str().unwrap_or(""),
            "currentNode":snapshot["currentNode"].as_str(),
            "elapsedSeconds":snapshot["elapsedSeconds"].as_u64().unwrap_or(0),
        }))
    }

    pub(super) async fn prepare(&self, kind: TaskKind, input: Value) -> Result<Preparation> {
        let cancel = self.shutdown.child_token();
        match ProviderRoute::from(kind) {
            ProviderRoute::Generation => Err(ApiError::new(
                410,
                "SD_RETIRED",
                "SD 新生成已退役；原任务可继续查询、收集或取消",
            )),
            ProviderRoute::Image(family) => {
                if kind.is_manga()
                    && (kind == TaskKind::Lineart) != (input["operation"] == "lineart")
                {
                    return Err(ApiError::invalid("漫画任务类型与操作不一致"));
                }
                self.images
                    .prepare(input, family, true, cancel)
                    .await
                    .map(Preparation::Image)
            }
            ProviderRoute::Video => self
                .video
                .prepare(input, true, cancel)
                .await
                .map(Preparation::Video),
            ProviderRoute::Batch => self
                .video
                .prepare_batch(input, true, cancel)
                .await
                .map(Preparation::Batch),
        }
    }
    pub(super) async fn query_provider(
        &self,
        kind: TaskKind,
        job: &str,
        principal: &str,
    ) -> Result<crate::execution::Observation> {
        match ProviderRoute::from(kind) {
            ProviderRoute::Generation => self.provider.query(job, principal).await,
            ProviderRoute::Image(family) => self.images.query(job, principal, family).await,
            ProviderRoute::Video => self.video.query(job, principal).await,
            ProviderRoute::Batch => self.video.query_batch(job, principal).await,
        }
    }
    pub(super) async fn cancel_provider(
        &self,
        kind: TaskKind,
        job: &str,
        principal: &str,
    ) -> Result<Value> {
        match ProviderRoute::from(kind) {
            ProviderRoute::Generation => self.provider.cancel(job, principal).await,
            ProviderRoute::Image(family) => self.images.cancel(job, principal, family).await,
            ProviderRoute::Video => self.video.cancel(job, principal).await,
            ProviderRoute::Batch => self.video.cancel_batch(job, principal).await,
        }
    }
}
