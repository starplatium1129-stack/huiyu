use crate::error::{ApiError, Result};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(super) struct Temporary {
    paths: Mutex<HashSet<PathBuf>>,
    cancel: CancellationToken,
    jobs: TaskTracker,
}
pub(super) struct InputFile {
    pub path: PathBuf,
    owner: Arc<Temporary>,
}
impl Temporary {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            paths: Mutex::new(HashSet::new()),
            cancel: CancellationToken::new(),
            jobs: TaskTracker::new(),
        })
    }
    pub async fn write(
        self: &Arc<Self>,
        root: &Path,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<InputFile> {
        if self.cancel.is_cancelled() || cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "Interrogation cancelled"));
        }
        tokio::fs::create_dir_all(root).await?;
        let path = root.join(format!(
            "aics_interrogate_{}.png",
            uuid::Uuid::new_v4().simple()
        ));
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .await?;
        let guard = InputFile {
            path: path.clone(),
            owner: self.clone(),
        };
        self.paths.lock().unwrap().insert(path);
        tokio::select! {result=output.write_all(bytes)=>result?,_=cancel.cancelled()=>return Err(ApiError::new(499,"CANCELLED","Interrogation cancelled"))};
        output.flush().await?;
        drop(output);
        if self.cancel.is_cancelled() || cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "Interrogation cancelled"));
        }
        Ok(guard)
    }
    fn remove(&self, path: &Path) {
        let removed = match std::fs::remove_file(path) {
            Ok(()) => true,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        };
        if removed {
            self.paths.lock().unwrap().remove(path);
        }
    }
    pub async fn close(&self) {
        self.cancel.cancel();
        self.jobs.close();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.jobs.wait()).await;
        let paths: Vec<_> = self.paths.lock().unwrap().iter().cloned().collect();
        for path in paths {
            self.remove(&path);
        }
        let remaining = self.paths.lock().unwrap().len();
        if remaining > 0 {
            eprintln!(
                "interrogate: {remaining} owned temporary input files remain locked by their consumer"
            );
        }
    }
}
impl Drop for InputFile {
    fn drop(&mut self) {
        if self.owner.cancel.is_cancelled() {
            self.owner.remove(&self.path);
            return;
        }
        let path = self.path.clone();
        let owner = self.owner.clone();
        self.owner.jobs.spawn(async move{
            tokio::select!{_=tokio::time::sleep(Duration::from_secs(5))=>{},_=owner.cancel.cancelled()=>{}};
            owner.remove(&path);
        });
    }
}
