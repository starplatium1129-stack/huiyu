use super::{LocalUpstream, local_url};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(crate) struct Probe {
    pub status: u16,
    pub json: Option<Value>,
    bytes: usize,
}
struct Observation {
    at: Instant,
    probe: Option<Arc<Probe>>,
}
struct Entry {
    value: watch::Receiver<Option<Arc<Observation>>>,
    cancel: CancellationToken,
}
/** Cache only bounded GET observations. Readiness, queues and process ownership stay with callers. */
pub(crate) struct HealthProbes {
    transport: LocalUpstream,
    entries: Mutex<HashMap<String, Entry>>,
    cancel: CancellationToken,
    tasks: TaskTracker,
}
impl HealthProbes {
    pub fn new(transport: LocalUpstream, cancel: CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            transport,
            entries: Mutex::new(HashMap::new()),
            cancel: cancel.child_token(),
            tasks: TaskTracker::new(),
        })
    }
    pub async fn read(
        &self,
        host: &str,
        path: &str,
        wait: Duration,
        limit: usize,
        fresh: bool,
    ) -> Option<Arc<Probe>> {
        let base = local_url(host).ok()?;
        if !path.starts_with('/') || path.starts_with("//") {
            return None;
        }
        let url = base.join(path).ok()?;
        if url.origin() != base.origin() || self.cancel.is_cancelled() {
            return None;
        }
        let key = url.to_string();
        let mut receiver = {
            let mut entries = self.entries.lock().unwrap();
            let usable = entries.get(&key).is_some_and(|entry| {
                let value = entry.value.borrow();
                value.as_ref().map_or_else(
                    || entry.value.has_changed().is_ok(),
                    |value| !fresh && value.at.elapsed() < Duration::from_secs(2),
                )
            });
            if !usable {
                // Fixed service endpoints normally occupy a handful of slots; expired configuration keys are bounded too.
                if entries.len() >= 32 && !entries.contains_key(&key) {
                    let oldest = entries
                        .iter()
                        .filter_map(|(key, entry)| {
                            entry
                                .value
                                .borrow()
                                .as_ref()
                                .map(|value| (key.clone(), value.at))
                        })
                        .min_by_key(|(_, at)| *at)
                        .map(|(key, _)| key);
                    let Some(oldest) = oldest else {
                        return None;
                    };
                    if let Some(old) = entries.remove(&oldest) {
                        old.cancel.cancel();
                    }
                }
                let (send, receive) = watch::channel(None);
                let (cancel, transport) = (self.cancel.child_token(), self.transport.clone());
                let (host, path, owned) = (host.to_owned(), path.to_owned(), cancel.clone());
                self.tasks.spawn(async move {
                    let probe = transport
                        .probe_json(
                            &host,
                            &path,
                            None,
                            Duration::from_secs(3),
                            8 * 1024 * 1024,
                            &owned,
                        )
                        .await
                        .ok()
                        .map(|(status, body, bytes)| {
                            Arc::new(Probe {
                                status,
                                json: body.ok(),
                                bytes,
                            })
                        });
                    send.send_replace(Some(Arc::new(Observation {
                        at: Instant::now(),
                        probe,
                    })));
                });
                entries.insert(
                    key.clone(),
                    Entry {
                        value: receive,
                        cancel,
                    },
                );
            }
            entries.get(&key)?.value.clone()
        };
        // Cancelling one HTTP observer cannot abort a shared probe still used by another endpoint.
        let observed = async {
            loop {
                if let Some(value) = receiver.borrow_and_update().clone() {
                    return value
                        .probe
                        .as_ref()
                        .filter(|probe| probe.bytes <= limit)
                        .cloned();
                }
                if receiver.changed().await.is_err() {
                    return None;
                }
            }
        };
        tokio::select! { _ = self.cancel.cancelled() => None, value = tokio::time::timeout(wait, observed) => value.ok().flatten() }
    }
    pub fn invalidate(&self) {
        for (_, entry) in self.entries.lock().unwrap().drain() {
            entry.cancel.cancel();
        }
    }
    pub async fn close(&self) {
        self.cancel.cancel();
        self.invalidate();
        self.tasks.close();
        self.tasks.wait().await;
    }
}
