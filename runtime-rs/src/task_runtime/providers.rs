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
            Self::Image(p) => &p.input,
            Self::Video(p) => &p.input,
            Self::Batch(p) => &p.input,
        }
    }
    pub(super) fn provider(&self) -> &str {
        match self {
            Self::Generation(p) => &p.provider,
            Self::Image(p) => &p.provider,
            Self::Video(p) => &p.provider,
            Self::Batch(p) => &p.provider,
        }
    }
}
impl TaskRuntime {
    pub(super) fn video(&self) -> Result<&Arc<crate::video::VideoService>> {
        self.video.as_ref().ok_or_else(|| {
            ApiError::new(
                501,
                "TASK_PROVIDER_NOT_MIGRATED",
                "Video task provider unavailable",
            )
        })
    }
    pub(super) async fn prepare(&self, kind: &str, input: Value) -> Result<Preparation> {
        let cancel = self.shutdown.child_token();
        if let Some(family) = image_family(kind) {
            let images = self.images.as_ref().ok_or_else(|| {
                ApiError::new(
                    501,
                    "TASK_PROVIDER_NOT_MIGRATED",
                    "Image task provider unavailable",
                )
            })?;
            return images
                .prepare(input, family, true, cancel)
                .await
                .map(Preparation::Image);
        }
        match kind {
            "video" => self
                .video()?
                .prepare(input, true, cancel)
                .await
                .map(Preparation::Video),
            "batch" => self
                .video()?
                .prepare_batch(input, true, cancel)
                .await
                .map(Preparation::Batch),
            _ => self
                .provider
                .prepare(input, true, cancel)
                .await
                .map(Preparation::Generation),
        }
    }
    pub(super) async fn query_provider(
        &self,
        kind: &str,
        job: &str,
        principal: &str,
    ) -> Result<crate::generation::Observation> {
        if let Some(family) = image_family(kind) {
            return self
                .images
                .as_ref()
                .ok_or_else(|| {
                    ApiError::new(
                        501,
                        "TASK_PROVIDER_NOT_MIGRATED",
                        "Image task provider unavailable",
                    )
                })?
                .query(job, principal, family)
                .await;
        }
        match kind {
            "generation" => self.provider.query(job, principal).await,
            "video" => self.video()?.query(job, principal).await,
            "batch" => self.video()?.query_batch(job, principal).await,
            _ => Err(ApiError::new(
                501,
                "TASK_PROVIDER_NOT_MIGRATED",
                "Task provider unavailable",
            )),
        }
    }
    pub(super) async fn cancel_provider(
        &self,
        kind: &str,
        job: &str,
        principal: &str,
    ) -> Result<Value> {
        if let Some(family) = image_family(kind) {
            return self
                .images
                .as_ref()
                .ok_or_else(|| {
                    ApiError::new(
                        501,
                        "TASK_PROVIDER_NOT_MIGRATED",
                        "Image task provider unavailable",
                    )
                })?
                .cancel(job, principal, family)
                .await;
        }
        match kind {
            "generation" => self.provider.cancel(job, principal).await,
            "video" => self.video()?.cancel(job, principal).await,
            "batch" => self.video()?.cancel_batch(job, principal).await,
            _ => Err(ApiError::new(
                501,
                "TASK_PROVIDER_NOT_MIGRATED",
                "Task provider unavailable",
            )),
        }
    }
}
