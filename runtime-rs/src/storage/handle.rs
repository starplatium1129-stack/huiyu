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
        let mutation = !is_read(command["kind"].as_str().unwrap_or(""));
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::Request(
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
    pub(crate) async fn task_media_chunk(
        &self,
        chunk: TaskMediaChunk,
        principal: &str,
    ) -> Result<u64> {
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Work::TaskMediaChunk(
                chunk,
                principal.into(),
                cancel.0.clone(),
                reply,
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
        self.verification.close().await;
        self.thumbnails.close().await;
        let (reply, result) = oneshot::channel();
        if self.sender.send(Work::Close(reply)).await.is_err() {
            return Ok(());
        }
        result.await.unwrap_or(Ok(()))
    }
}
