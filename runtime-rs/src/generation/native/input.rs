use super::*;
use crate::file_identity;
use sha2::{Digest, Sha256};
use std::{fs::File, io::{Read, Write}, path::Path, sync::LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

static IO: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));
async fn worker(cancel: &CancellationToken) -> Result<OwnedSemaphorePermit> {
    tokio::select! { biased;
        _ = cancel.cancelled() => Err(cancelled()),
        permit = IO.clone().acquire_owned() => permit.map_err(|_| cancelled()),
    }
}

#[derive(Clone)]
pub(crate) struct InputFile {
    file: Arc<tempfile::NamedTempFile>,
    identity: file_identity::Identity,
    version: file_identity::Version,
    pub bytes: u64,
    pub hash: String,
}
impl InputFile {
    pub async fn capture(root: PathBuf, bytes: Arc<Vec<u8>>, cancel: &CancellationToken) -> Result<Self> {
        let permit = worker(cancel).await?;
        let cancel = cancel.child_token();
        let _guard = cancel.clone().drop_guard();
        let wait_cancel = cancel.clone();
        let work = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            std::fs::create_dir_all(&root)?;
            let mut file = tempfile::Builder::new().prefix("image-input-").tempfile_in(root)?;
            let mut hash = Sha256::new();
            for chunk in bytes.chunks(256 * 1024) {
                if cancel.is_cancelled() { return Err(cancelled()); }
                file.write_all(chunk)?;
                hash.update(chunk);
            }
            file.flush()?;
            if cancel.is_cancelled() { return Err(cancelled()); }
            Ok(Self {
                identity: file_identity::opened(file.as_file())?,
                version: file_identity::Version::of(file.as_file())?,
                file: Arc::new(file), bytes: bytes.len() as u64,
                hash: hex::encode(hash.finalize()),
            })
        });
        tokio::select! { biased;
            _ = wait_cancel.cancelled() => Err(cancelled()),
            result = work => result.map_err(|_| ApiError::new(503, "TASK_INPUT_UNAVAILABLE", "输入快照准备未完成"))?,
        }
    }
    pub async fn matches(&self, source: File, limit: u64, cancel: &CancellationToken) -> Result<bool> {
        let permit = worker(cancel).await?;
        let expected = self.clone();
        let cancel = cancel.child_token();
        let _guard = cancel.clone().drop_guard();
        let wait_cancel = cancel.clone();
        let work = tokio::task::spawn_blocking(move || {
            // Cancellation stops the caller immediately; actual I/O retains its
            // slot and snapshot until this worker has really finished.
            let _permit = permit;
            let mut source = source.take(limit + 1);
            let mut buffer = [0; 256 * 1024];
            let mut length = 0u64;
            let mut hash = Sha256::new();
            loop {
                if cancel.is_cancelled() { return Err(cancelled()); }
                let count = source.read(&mut buffer)?;
                if count == 0 { break; }
                hash.update(&buffer[..count]);
                length += count as u64;
            }
            if length == 0 || length > limit {
                return Err(ApiError::new(400, "TASK_INPUT_INVALID", "输入图像超过 16 MiB"));
            }
            if cancel.is_cancelled() { return Err(cancelled()); }
            Ok(length == expected.bytes && hex::encode(hash.finalize()) == expected.hash)
        });
        tokio::select! { biased;
            _ = wait_cancel.cancelled() => Err(cancelled()),
            result = work => result.map_err(|_| ApiError::new(503, "TASK_INPUT_UNAVAILABLE", "输入图像校验未完成"))?,
        }
    }
    pub fn path(&self) -> &Path { self.file.path() }
    pub fn check(&self) -> Result<()> {
        let current = File::open(self.path())?;
        if file_identity::opened(&current)? != self.identity
            || file_identity::Version::of(&current)? != self.version
            || file_identity::Version::of(self.file.as_file())? != self.version
        {
            return Err(ApiError::new(409, "TASK_INPUT_CHANGED", "已接受的输入快照发生变化"));
        }
        Ok(())
    }
}

// The process entry owns these files until ready or confirmed retirement, even
// if the request future or its Plan is dropped while Python is still reading.
pub(super) struct RunFiles {
    pub _output: Arc<tempfile::TempDir>,
    pub _inputs: Vec<InputFile>,
}
fn cancelled() -> ApiError { ApiError::new(499, "CANCELLED", "输入快照准备已取消") }
