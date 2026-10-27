use crate::error::{ApiError, Result};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};
use tokio_util::{
    sync::CancellationToken,
    task::{TaskTracker, task_tracker::TaskTrackerToken},
};

pub(in crate::storage) struct Readers {
    active: TaskTracker,
    closed: Mutex<CancellationToken>,
}

impl Readers {
    pub fn new() -> Self {
        Self {
            active: TaskTracker::new(),
            closed: Mutex::new(CancellationToken::new()),
        }
    }

    pub fn begin(&self) -> Result<(TaskTrackerToken, CancellationToken)> {
        let closed = self.closed.lock().unwrap();
        if closed.is_cancelled() {
            return Err(super::super::unavailable());
        }
        // Register under the same lock as close: TaskTracker allows tokens after
        // closure, which could otherwise let workspace shutdown miss a decoder.
        Ok((self.active.token(), closed.child_token()))
    }

    pub async fn close(&self) {
        {
            let closed = self.closed.lock().unwrap();
            closed.cancel();
            self.active.close();
        }
        self.active.wait().await;
    }
}

pub(super) struct Queue {
    decoders: Arc<Semaphore>,
    images: Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>,
}

impl Queue {
    pub fn new() -> Self {
        Self {
            decoders: Arc::new(Semaphore::new(2)),
            images: Mutex::new(HashMap::new()),
        }
    }

    pub async fn image(&self, cache: PathBuf) -> OwnedMutexGuard<()> {
        let lock = {
            let mut images = self.images.lock().unwrap();
            // Retain only live work/waiters, never every image seen over the
            // application's lifetime. Warm cache hits do not enter this map.
            images.retain(|_, lock| lock.strong_count() > 0);
            match images.get(&cache).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    images.insert(cache, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    pub async fn decoder(&self) -> Result<OwnedSemaphorePermit> {
        self.decoders
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ApiError::new(503, "STORAGE_UNAVAILABLE", "Thumbnail worker unavailable"))
    }
}
