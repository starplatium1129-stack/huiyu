use crate::error::{ApiError, Result};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

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
