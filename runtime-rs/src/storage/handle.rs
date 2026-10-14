use super::*;

impl Storage {
    pub async fn open(root: PathBuf, workspace_id: String, create: bool) -> Result<Self> {
        let epoch = uuid::Uuid::new_v4().to_string();
        let storage_root = Arc::new(root.clone());
        let (sender, receiver) = mpsc::channel(64);
        let (opened, ready) = oneshot::channel();
        let (id, thread_epoch) = (workspace_id.clone(), epoch.clone());
        let weak_sender = sender.downgrade();
        std::thread::Builder::new()
            .name("workspace-sqlite".into())
            .spawn(move || {
                worker::run(
                    root,
                    id,
                    thread_epoch,
                    create,
                    receiver,
                    opened,
                    weak_sender,
                )
            })?;
        ready.await.map_err(|_| unavailable())??;
        Ok(Self {
            sender,
            workspace_id: workspace_id.into(),
            runtime_epoch: epoch.into(),
            root: storage_root,
            native_images: None,
            verification: Arc::new(verification::Verifier::new()),
            thumbnails: Arc::new(thumbnail::Readers::new()),
            result_writes: Arc::new(tokio::sync::Semaphore::new(1)),
            search_warming: Arc::new(AtomicBool::new(false)),
        })
    }
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }
    pub fn with_native_images(mut self, library: PathBuf) -> Self {
        self.native_images = Some(Arc::new(library));
        self
    }
    pub fn runtime_epoch(&self) -> &str {
        &self.runtime_epoch
    }
    pub async fn request(&self, command: Value, principal: &str) -> Result<Value> {
        if principal.is_empty() {
            return Err(ApiError::new(
                401,
                "UNAUTHORIZED",
                "Desktop principal is required",
            ));
        }
        if command["kind"] == "readThumbnail" {
            return thumbnail::read(self, &command).await;
        }
        if command["kind"] == "readMedia" {
            return verification::read(self, &command).await;
        }
        if matches!(
            command["kind"].as_str(),
            Some("searchArtworks" | "readArtworkRecentIndex")
        ) {
            return artwork_index::request(self, command, principal).await;
        }
        let mutation = !is_read(command["kind"].as_str().unwrap_or(""));
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        let permit = if result_commit::is_write(&command) {
            Some(self.result_permit().await?)
        } else {
            None
        };
        let work = Work::Request(command, principal.into(), cancel.0.clone(), reply, permit);
        self.sender.send(work).await.map_err(|_| unavailable())?;
        result.await.map_err(|_| {
            if mutation {
                commit_unknown()
            } else {
                unavailable()
            }
        })?
    }
    pub async fn task(
        &self,
        command: crate::task_contract::TaskCommand,
        principal: &str,
    ) -> Result<Value> {
        let mutation = !command.is_read();
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::Task(
                command,
                principal.into(),
                cancel.0.clone(),
                reply,
            ))
            .await
            .map_err(|_| unavailable())?;
        result.await.map_err(|_| {
            if mutation {
                commit_unknown()
            } else {
                unavailable()
            }
        })?
    }
    pub(crate) async fn task_record(
        &self,
        task_id: &str,
        principal: &str,
    ) -> Result<Option<crate::task_contract::TaskRecord>> {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::TaskRecord(
                task_id.into(),
                principal.into(),
                cancel.0.clone(),
                reply,
            ))
            .await
            .map_err(|_| unavailable())?;
        result.await.map_err(|_| unavailable())?
    }
    pub(crate) async fn task_result_reference(
        &self,
        task_id: &str,
        index: u64,
        principal: &str,
    ) -> Result<tasks::ResultReference> {
        let value = self
            .request(
                json!({"kind":"task.result.reference","taskId":task_id,"index":index}),
                principal,
            )
            .await?;
        serde_json::from_value(value).map_err(Into::into)
    }
    pub(crate) async fn task_revision(
        &self,
        task_id: &str,
        principal: &str,
    ) -> Result<Option<i64>> {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::TaskRevision(
                task_id.into(),
                principal.into(),
                cancel.0.clone(),
                reply,
            ))
            .await
            .map_err(|_| unavailable())?;
        result.await.map_err(|_| unavailable())?
    }
    pub(crate) async fn begin_task_result_import(
        &self,
        task_id: &str,
        index: u64,
        alias: &str,
        lease_id: &str,
        principal: &str,
    ) -> Result<tasks::ResultReference> {
        let value = self
            .request(
                json!({"kind":"task.result.import.begin",
            "taskId":task_id,"index":index,"alias":alias,"leaseId":lease_id}),
                principal,
            )
            .await?;
        serde_json::from_value(value).map_err(Into::into)
    }
    pub(crate) async fn end_task_result_import(
        &self,
        lease_id: &str,
        principal: &str,
    ) -> Result<()> {
        self.request(
            json!({"kind":"task.result.import.end","leaseId":lease_id}),
            principal,
        )
        .await?;
        Ok(())
    }
    pub(crate) async fn task_media_copy(
        &self,
        command: Value,
        source: TaskMediaSource,
        principal: &str,
    ) -> Result<Value> {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        let permit = self.result_permit().await?;
        self.sender
            .send(Work::TaskMediaCopy(
                command,
                source,
                principal.into(),
                cancel.0.clone(),
                reply,
                permit,
            ))
            .await
            .map_err(|_| unavailable())?;
        result.await.map_err(|_| commit_unknown())?
    }
    pub async fn media(&self, alias: &str) -> Result<Media> {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::Media(alias.into(), cancel.0.clone(), reply))
            .await
            .map_err(|_| unavailable())?;
        let media = result.await.map_err(|_| unavailable())??;
        self.verification
            .verify(self.root.clone(), media, self.sender.clone())
            .await
    }
    pub async fn close(&self) -> Result<()> {
        // Wake input/result writers outside the actor before draining admitted work.
        self.result_writes.close();
        self.verification.close().await;
        self.thumbnails.close().await;
        let (reply, result) = oneshot::channel();
        if self.sender.send(Work::Close(reply)).await.is_err() {
            return Ok(());
        }
        result.await.unwrap_or(Ok(()))
    }
    async fn result_permit(&self) -> Result<OwnedSemaphorePermit> {
        self.result_writes
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| unavailable())
    }
}
