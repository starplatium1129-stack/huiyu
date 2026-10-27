use super::*;

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
            Self::Generation(p) => &p.provider,
            Self::Image(p) => p.provider(),
            Self::Video(p) => p.provider(),
            Self::Batch(p) => &p.provider,
        }
    }
}
impl TaskRuntime {
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
        let family = match task["kind"].as_str()? {
            "anima" => "anima",
            "creative" => "krea2",
            _ => return None,
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
        match kind {
            TaskKind::Generation => Err(ApiError::new(
                410,
                "SD_RETIRED",
                "SD 新生成已退役；原任务可继续查询、收集或取消",
            )),
            TaskKind::Anima
            | TaskKind::Creative
            | TaskKind::Qwen
            | TaskKind::Moss
            | TaskKind::Manga
            | TaskKind::Lineart => {
                if kind.is_manga()
                    && (kind == TaskKind::Lineart) != (input["operation"] == "lineart")
                {
                    return Err(ApiError::invalid("漫画任务类型与操作不一致"));
                }
                let family = if kind == TaskKind::Anima {
                    "anima"
                } else if kind == TaskKind::Qwen {
                    "qwen-image"
                } else if kind == TaskKind::Moss {
                    "moss-image"
                } else if kind.is_manga() {
                    "manga-screen"
                } else {
                    "krea2"
                };
                self.images
                    .prepare(input, family, true, cancel)
                    .await
                    .map(Preparation::Image)
            }
            TaskKind::Video => self
                .video
                .prepare(input, true, cancel)
                .await
                .map(Preparation::Video),
            TaskKind::Batch => self
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
        match kind {
            TaskKind::Generation => self.provider.query(job, principal).await,
            TaskKind::Anima => self.images.query(job, principal, "anima").await,
            TaskKind::Creative => self.images.query(job, principal, "krea2").await,
            TaskKind::Qwen => self.images.query(job, principal, "qwen-image").await,
            TaskKind::Moss => self.images.query(job, principal, "moss-image").await,
            TaskKind::Manga | TaskKind::Lineart => {
                self.images.query(job, principal, "manga-screen").await
            }
            TaskKind::Video => self.video.query(job, principal).await,
            TaskKind::Batch => self.video.query_batch(job, principal).await,
        }
    }
    pub(super) async fn cancel_provider(
        &self,
        kind: TaskKind,
        job: &str,
        principal: &str,
    ) -> Result<Value> {
        match kind {
            TaskKind::Generation => self.provider.cancel(job, principal).await,
            TaskKind::Anima => self.images.cancel(job, principal, "anima").await,
            TaskKind::Creative => self.images.cancel(job, principal, "krea2").await,
            TaskKind::Qwen => self.images.cancel(job, principal, "qwen-image").await,
            TaskKind::Moss => self.images.cancel(job, principal, "moss-image").await,
            TaskKind::Manga | TaskKind::Lineart => {
                self.images.cancel(job, principal, "manga-screen").await
            }
            TaskKind::Video => self.video.cancel(job, principal).await,
            TaskKind::Batch => self.video.cancel_batch(job, principal).await,
        }
    }
}
