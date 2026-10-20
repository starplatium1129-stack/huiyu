use super::*;

impl Storage {
    pub(crate) async fn export_portable_backup(&self, id: String, target: PathBuf, job: Arc<crate::workspace_jobs::Job>) -> Result<Value> {
        let root = self.root.as_ref().clone(); let workspace_id = self.workspace_id.to_string();
        tokio::task::spawn_blocking(move || backup::portable::export(root,workspace_id,id,target,job)).await.map_err(|_| unavailable())?
    }
    pub(crate) async fn import_portable_backup(source: PathBuf, destination: PathBuf, id: String, principal: String, job: Arc<crate::workspace_jobs::Job>) -> Result<Value> {
        tokio::task::spawn_blocking(move || backup::portable::import(source,destination,id,principal,job)).await.map_err(|_| unavailable())?
    }
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
            jobs: Arc::default(),
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
        self.request_job(command, principal, None).await
    }
    pub(crate) async fn request_job(&self, command: Value, principal: &str, job: Option<Arc<crate::workspace_jobs::Job>>) -> Result<Value> {
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
        if matches!(
            command["kind"].as_str(),
            Some("searchArtworks" | "readArtworkRecentIndex")
        ) {
            return artwork_index::request(self, command, principal).await;
        }
        let mutation = !is_read(command["kind"].as_str().unwrap_or(""));
        let cancellation = job.as_ref().map(|job| job.cancel.clone()).unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        let _cancel_on_drop = job.is_none().then(|| CancelOnDrop(cancellation.clone()));
        let (reply, result) = oneshot::channel();
        let permit = if result_commit::is_write(&command) {
            Some(self.result_permit().await?)
        } else {
            None
        };
        let work = Work::Request(command, principal.into(), cancellation, reply, permit, job);
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
        self.task_record_lookup(tasks::RecordKey::Id(task_id.into()), principal)
            .await
    }
    pub(crate) async fn task_record_by_request(
        &self,
        request_key: &str,
        principal: &str,
    ) -> Result<Option<crate::task_contract::TaskRecord>> {
        self.task_record_lookup(tasks::RecordKey::Request(request_key.into()), principal)
            .await
    }
    async fn task_record_lookup(
        &self,
        key: tasks::RecordKey,
        principal: &str,
    ) -> Result<Option<crate::task_contract::TaskRecord>> {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::TaskRecord(
                key,
                principal.into(),
                cancel.0.clone(),
                reply,
            ))
            .await
            .map_err(|_| unavailable())?;
        result.await.map_err(|_| unavailable())?
    }
    pub(crate) async fn task_recovery_page(
        &self,
        query: crate::task_contract::TaskListQuery,
        principal: &str,
    ) -> Result<tasks::RecoveryPage> {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::TaskRecoveryPage(
                query,
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
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::TaskResultReference(
                task_id.into(),
                index,
                principal.into(),
                cancel.0.clone(),
                reply,
            ))
            .await
            .map_err(|_| unavailable())?;
        result.await.map_err(|_| unavailable())?
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
    pub(crate) async fn begin_workspace_media_import(
        &self,
        alias: &str,
        lease_id: &str,
        principal: &str,
        expected: Option<(&str, u64)>,
    ) -> Result<crate::task_contract::ResultRef> {
        let value = self
            .request(
                json!({"kind":"task.result.import.workspace","alias":alias,"leaseId":lease_id,
                    "expected":expected.map(|(sha256,bytes)|json!({"sha256":sha256,"bytes":bytes}))}),
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
        Ok(self.open_media(alias).await?.media)
    }
    pub(crate) async fn open_media(&self, alias: &str) -> Result<OpenedMedia> {
        let media = self.lookup_media(alias).await?;
        self.verification
            .verify(self.root.clone(), media, self.sender.clone())
            .await
    }
    pub(crate) async fn finish_media(&self, alias: &str, source: OpenedMedia) -> Result<()> {
        let media = self.lookup_media(alias).await?;
        self.verification
            .finish(self.root.clone(), source, media, self.sender.clone())
            .await
    }
    async fn lookup_media(&self, alias: &str) -> Result<Media> {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::Media(alias.into(), cancel.0.clone(), reply))
            .await
            .map_err(|_| unavailable())?;
        result.await.map_err(|_| unavailable())?
    }
    pub async fn close(&self) -> Result<()> {
        self.jobs.cancel_all();
        // Wake input/result writers outside the actor before draining admitted work.
        self.result_writes.close();
        self.jobs.close().await;
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
