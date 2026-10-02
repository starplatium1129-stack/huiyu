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
    #[cfg(test)]
    pause: Mutex<Option<Pause>>,
}

impl Readers {
    pub fn new() -> Self {
        Self {
            active: TaskTracker::new(),
            closed: Mutex::new(CancellationToken::new()),
            #[cfg(test)]
            pause: Mutex::new(None),
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

    #[cfg(test)]
    pub fn pause(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (resume, receiver) = std::sync::mpsc::channel();
        *self.pause.lock().unwrap() = Some(Pause {
            entered,
            resume: receiver,
        });
        (ready, resume)
    }

    #[cfg(test)]
    pub fn paused(&self) {
        let pause = self.pause.lock().unwrap().take();
        if let Some(pause) = pause {
            let _ = pause.entered.send(());
            let _ = pause.resume.recv();
        }
    }
}

#[cfg(test)]
struct Pause {
    entered: tokio::sync::oneshot::Sender<()>,
    resume: std::sync::mpsc::Receiver<()>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn duplicate_waiters_do_not_take_other_images_decoder_slots() {
        let queue = Queue::new();
        let first = queue.image("workspace-a/hash.jpg".into()).await;
        let decoder = queue.decoder().await.unwrap();
        let duplicate = queue.image("workspace-a/hash.jpg".into());
        tokio::pin!(duplicate);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut duplicate)
                .await
                .is_err()
        );
        let other = queue.image("workspace-b/hash.jpg".into()).await;
        let second_decoder = tokio::time::timeout(Duration::from_secs(1), queue.decoder())
            .await
            .unwrap()
            .unwrap();
        drop(first);
        let duplicate_guard = tokio::time::timeout(Duration::from_secs(1), &mut duplicate)
            .await
            .unwrap();
        drop((duplicate_guard, other, decoder, second_decoder));
    }

    #[tokio::test]
    async fn completed_and_cancelled_keys_do_not_accumulate() {
        let queue = Queue::new();
        for i in 0..100 {
            let key = PathBuf::from(format!("{i}.jpg"));
            let active = queue.image(key.clone()).await;
            {
                let waiter = queue.image(key);
                tokio::pin!(waiter);
                assert!(
                    tokio::time::timeout(Duration::ZERO, &mut waiter)
                        .await
                        .is_err()
                );
            }
            drop(active);
        }
        let _active = queue.image("last.jpg".into()).await;
        assert_eq!(queue.images.lock().unwrap().len(), 1);
    }
}
