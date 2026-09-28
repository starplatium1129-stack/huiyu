use super::{CancelWork, Live2dService, catalog};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio_util::task::TaskTracker;

const MAX_AGE: Duration = Duration::from_secs(4);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(60);

struct Observation {
    available: bool,
    checked_at: u64,
    at: Instant,
    revision: u64,
}

#[derive(Default)]
pub(super) struct Health {
    observation: Mutex<Option<Observation>>,
    revision: AtomicU64,
    refreshing: AtomicBool,
    tasks: TaskTracker,
}

impl Health {
    pub fn invalidate(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
    }

    fn snapshot(&self) -> Value {
        // This mutex protects only a tiny value; no disk or async work owns it.
        let observation = self.observation.lock().unwrap();
        let revision = self.revision.load(Ordering::Acquire);
        json!({
            "available": observation.as_ref().is_some_and(|value| value.available),
            "checkedAt": observation.as_ref().map(|value| value.checked_at),
            "stale": observation.as_ref().is_none_or(|value| value.revision != revision || value.at.elapsed() >= MAX_AGE),
            "refreshing": self.refreshing.load(Ordering::Acquire),
        })
    }
}

struct RefreshGuard(Arc<Health>);
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0.refreshing.store(false, Ordering::Release);
    }
}

impl Live2dService {
    /// Return the last capability observation immediately; cold starts are
    /// unavailable/stale until the bounded background filesystem check finishes.
    pub fn health_status(&self) -> Value {
        let mut value = self.health.snapshot();
        if value["stale"] == true
            && !self.shutdown.is_cancelled()
            && self
                .health
                .refreshing
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            let service = self.clone();
            self.health.tasks.spawn(async move {
                service.refresh_health().await;
            });
            value["refreshing"] = true.into();
        }
        value
    }

    async fn refresh_health(self) {
        let guard = RefreshGuard(self.health.clone());
        let cancel = self.shutdown.child_token();
        let _cancel = CancelWork(cancel.clone());
        let deadline = tokio::time::Instant::now() + REFRESH_TIMEOUT;
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep_until(deadline) => return,
            permit = self.workers.clone().acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => return,
            }
        };
        let work_cancel = cancel.clone();
        let revision = self.health.revision.load(Ordering::Acquire);
        let mut worker = tokio::task::spawn_blocking(move || {
            // Hold the deduplication flag and permit until the actual blocking
            // work exits, including after timeout or service cancellation.
            let (_guard, _permit) = (guard, permit);
            if let Some(snapshot) =
                catalog::scan(&self.builtins, Some(&self.local), Some(&work_cancel))
                && !work_cancel.is_cancelled()
            {
                *self.health.observation.lock().unwrap() = Some(Observation {
                    available: snapshot.status["available"] == true,
                    checked_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    at: Instant::now(),
                    revision,
                });
            }
        });
        tokio::select! {
            _ = &mut worker => {},
            _ = cancel.cancelled() => { let _ = worker.await; },
            _ = tokio::time::sleep_until(deadline) => {
                cancel.cancel();
                let _ = worker.await;
            },
        }
    }

    pub async fn close(&self) {
        self.shutdown.cancel();
        self.health.tasks.close();
        self.health.tasks.wait().await;
    }
}

#[cfg(test)]
mod tests;
