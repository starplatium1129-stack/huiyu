//! Coalesce only concurrent Live2D reads, separately for body and hash-only modes.
//! No completed verification is cached: every later flight hashes all dependencies again.
use super::{Error, Result, Service, fs, resolve::Snapshot};
use axum::body::Bytes;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
const BUDGET: u32 = 64 * 1024 * 1024;
type Key = (usize, usize, bool);
struct Verified {
    files: Vec<Vec<u8>>,
    _memory: Option<OwnedSemaphorePermit>,
}
struct Published(Arc<Verified>, usize);
impl AsRef<[u8]> for Published {
    fn as_ref(&self) -> &[u8] {
        &self.0.files[self.1]
    }
}
struct Flight {
    done: Notify,
    result: Mutex<Option<Result<Arc<Verified>>>>,
    listeners: AtomicUsize,
    cancel: CancellationToken,
}
struct Listener(Arc<Flight>);
impl Listener {
    fn join(flight: &Arc<Flight>) -> Option<Self> {
        if flight.cancel.is_cancelled() {
            return None;
        }
        flight
            .listeners
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count > 0).then(|| count.checked_add(1)).flatten()
            })
            .ok()
            .map(|_| Self(flight.clone()))
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        if self.0.listeners.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.cancel.cancel();
        }
    }
}
pub(super) struct GroupReads {
    pending: Mutex<HashMap<Key, Arc<Flight>>>,
    started: Notify,
    workers: Arc<Semaphore>,
    memory: Arc<Semaphore>,
}
impl Default for GroupReads {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            started: Notify::new(),
            workers: Arc::new(Semaphore::new(2)),
            memory: Arc::new(Semaphore::new(BUDGET as usize)),
        }
    }
}
pub(super) fn size(snapshot: &Snapshot, group: usize) -> Option<u32> {
    snapshot.groups[group]
        .paths
        .iter()
        .try_fold(0_u64, |total, name| {
            total.checked_add(snapshot.entries[name].bytes)
        })
        .filter(|total| *total <= u64::from(BUDGET))
        .map(|total| total as u32)
}
impl GroupReads {
    pub async fn get(
        self: &Arc<Self>,
        service: &Arc<Service>,
        snapshot: Arc<Snapshot>,
        group: usize,
        file: usize,
        collect: bool,
    ) -> Result<Bytes> {
        let waiting = self.wait(service, snapshot, group, collect);
        let verified = tokio::select! {biased;
         _=service.read_cancel.cancelled()=>return Err(Error::new("CANCELLED","Resource read cancelled")),
         result=tokio::time::timeout(std::time::Duration::from_secs(60),waiting)=>result.map_err(|_|Error::new("RESOURCE_BUSY","Resource read admission timed out"))??,
        };
        // Bytes frames retain allocation and byte permits through their last drop.
        Ok(if collect {
            Bytes::from_owner(Published(verified, file))
        } else {
            Bytes::new()
        })
    }
    async fn wait(
        self: &Arc<Self>,
        service: &Arc<Service>,
        snapshot: Arc<Snapshot>,
        group: usize,
        collect: bool,
    ) -> Result<Arc<Verified>> {
        let key = (Arc::as_ptr(&snapshot) as usize, group, collect);
        let listener = self
            .pending
            .lock()
            .unwrap()
            .get(&key)
            .and_then(Listener::join);
        let listener = if let Some(listener) = listener {
            listener
        } else {
            let (joined, slot) = {
                let acquiring = self.workers.clone().acquire_owned();
                tokio::pin!(acquiring);
                loop {
                    let started = self.started.notified();
                    tokio::pin!(started);
                    started.as_mut().enable();
                    let joined = self
                        .pending
                        .lock()
                        .unwrap()
                        .get(&key)
                        .and_then(Listener::join);
                    if joined.is_some() {
                        break (joined, None);
                    }
                    // Keep FIFO ticket across unrelated starts; join matching flight immediately.
                    tokio::select! {
                     slot=&mut acquiring=>break(None,Some(slot.map_err(|_|Error::new("CANCELLED","Resource readers closed"))?)),
                     _=started=>{},
                    }
                }
            };
            if let Some(listener) = joined {
                return Self::completed(listener).await;
            }
            let slot = Arc::new(slot.unwrap());
            let (listener, start) = {
                let mut pending = self.pending.lock().unwrap();
                if let Some(listener) = pending.get(&key).and_then(Listener::join) {
                    (listener, false)
                } else {
                    let flight = Arc::new(Flight {
                        done: Notify::new(),
                        result: Mutex::new(None),
                        listeners: AtomicUsize::new(1),
                        cancel: service.read_cancel.child_token(),
                    });
                    pending.insert(key, flight.clone());
                    self.started.notify_waiters();
                    (Listener(flight), true)
                }
            };
            if start {
                let (owner, flight) = (self.clone(), listener.0.clone());
                service.workers.spawn(async move {
                    let result = async {
                        let memory = if collect {
                            Some(tokio::select! { biased;
                                _ = flight.cancel.cancelled() => return Err(Error::new("CANCELLED", "Resource read cancelled")),
                                permit = owner.memory.clone().acquire_many_owned(size(&snapshot, group).unwrap()) => {
                                    permit.map_err(|_| Error::new("CANCELLED", "Resource memory closed"))?
                                }
                            })
                        } else { None };
                        let (worker_slot, cancel, source) = (slot.clone(), flight.cancel.clone(), snapshot.clone());
                        super::blocking(move || {
                            // A cancelled listener cannot release admission before
                            // the underlying blocking verifier actually exits.
                            let _slot = worker_slot;
                            let mut files = Vec::new();
                            for name in &source.groups[group].paths {
                                let path = fs::child(&source.root, name)?;
                                let entry = &source.entries[name];
                                if collect {
                                    files.push(fs::verified_bytes(&path, entry, &cancel)?);
                                } else if !fs::file_matches(&path, entry, &cancel)? {
                                    return Err(Error::new("CONTENT_INVALID", "Live2D dependency changed"));
                                }
                            }
                            Ok(Arc::new(Verified { files, _memory: memory }))
                        }).await
                    }.await;
                    let mut pending = owner.pending.lock().unwrap();
                    if pending.get(&key).is_some_and(|current| Arc::ptr_eq(current, &flight)) {
                        pending.remove(&key);
                    }
                    *flight.result.lock().unwrap() = Some(result);
                    flight.done.notify_waiters();
                    // Preserve snapshot identity and producer slot until removal.
                    drop(snapshot);
                    drop(slot);
                });
            }
            listener
        };
        Self::completed(listener).await
    }
    async fn completed(listener: Listener) -> Result<Arc<Verified>> {
        loop {
            let notified = listener.0.done.notified();
            if let Some(result) = listener.0.result.lock().unwrap().as_ref() {
                return result.clone();
            }
            notified.await;
        }
    }
    #[cfg(test)]
    pub fn retained_bytes(&self) -> usize {
        BUDGET as usize - self.memory.available_permits()
    }
    #[cfg(test)]
    pub fn listeners(&self) -> usize {
        self.pending
            .lock()
            .unwrap()
            .values()
            .map(|f| f.listeners.load(Ordering::Acquire))
            .sum()
    }
}
