use crate::error::{ApiError, Result};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    future::Future,
    panic::AssertUnwindSafe,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Default)]
pub(crate) struct Jobs {
    entries: Mutex<VecDeque<Arc<Job>>>,
    tasks: TaskTracker,
}
pub(crate) struct Job {
    principal: String,
    input: Value,
    pub cancel: Arc<AtomicBool>,
    progress: Mutex<Progress>,
    outcome: Mutex<Option<Result<Value>>>,
}
#[derive(Clone, Copy, serde::Serialize)]
struct Progress {
    phase: &'static str,
    completed: u64,
    total: u64,
}
impl Job {
    fn matches(&self, principal: &str, id: &str) -> bool {
        self.principal == principal && self.input["operationId"] == id
    }
    pub fn check(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(ApiError::new(
                499,
                "CANCELLED",
                "Workspace operation was cancelled",
            ))
        } else {
            Ok(())
        }
    }
    pub fn progress(&self, phase: &'static str, completed: u64, total: u64) {
        *self.progress.lock().unwrap() = Progress {
            phase,
            completed,
            total,
        };
    }
    fn snapshot(&self) -> Value {
        let outcome = self.outcome.lock().unwrap();
        let progress = *self.progress.lock().unwrap();
        let mut value = json!({"operationId":self.input["operationId"],"kind":self.input["kind"],"state":"running","progress":progress});
        match outcome.as_ref() {
            Some(Ok(result)) => {
                value["state"] = json!("succeeded");
                value["result"] = result.clone();
            }
            Some(Err(error)) => {
                value["state"] = json!(if error.code == "CANCELLED" {
                    "cancelled"
                } else {
                    "failed"
                });
                value["error"] = json!(error.message);
                value["code"] = json!(error.code);
            }
            None if self.cancel.load(Ordering::Relaxed) => {
                value["state"] = json!("cancelling");
                value["progress"]["phase"] = json!("cancelling");
            }
            None => {}
        }
        value
    }
}
impl Jobs {
    pub fn start<F, Fut>(
        &self,
        principal: &str,
        input: Value,
        shutdown: CancellationToken,
        work: F,
    ) -> Result<Value>
    where
        F: FnOnce(Arc<Job>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Value>> + Send + 'static,
    {
        let id = input["operationId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 200)
            .ok_or_else(|| ApiError::invalid("A stable operation ID is required"))?;
        let mut entries = self.entries.lock().unwrap();
        if self.tasks.is_closed() || shutdown.is_cancelled() {
            return Err(ApiError::new(
                503,
                "SHUTTING_DOWN",
                "Workspace operations are closing",
            ));
        }
        let previous = entries.iter().position(|job| job.matches(principal, id));
        if let Some(index) = previous {
            let job = &entries[index];
            if job.input != input {
                return Err(ApiError::new(
                    409,
                    "OPERATION_CONFLICT",
                    "Operation ID has different input",
                ));
            }
            if !matches!(job.outcome.lock().unwrap().as_ref(), Some(Err(_))) {
                let job = job.clone();
                drop(entries);
                return Ok(job.snapshot());
            }
        }
        if entries
            .back()
            .is_some_and(|job| job.outcome.lock().unwrap().is_none())
        {
            return Err(ApiError::new(
                409,
                "WORKSPACE_BUSY",
                "Another workspace operation is running",
            ));
        }
        // Only one operation runs at a time and it is always the newest entry.
        if let Some(index) = previous {
            entries.remove(index);
        } else if entries.len() >= 32 {
            entries.pop_front();
        }
        let job = Arc::new(Job {
            principal: principal.to_owned(),
            input,
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Mutex::new(Progress {
                phase: "preparing",
                completed: 0,
                total: 0,
            }),
            outcome: Mutex::new(None),
        });
        entries.push_back(job.clone());
        let snapshot = job.snapshot();
        self.tasks.spawn(async move {
            let future = AssertUnwindSafe(async { work(job.clone()).await }).catch_unwind();
            tokio::pin!(future);
            let result = tokio::select! {
                result = &mut future => result,
                _ = shutdown.cancelled() => { job.cancel.store(true,Ordering::Relaxed); future.await }
            };
            *job.outcome.lock().unwrap() = Some(result.unwrap_or_else(|_| {
                Err(ApiError::new(503, "WORKSPACE_JOB_INTERRUPTED", "Workspace worker stopped unexpectedly"))
            }));
        });
        Ok(snapshot)
    }
    pub fn status(&self, principal: &str, id: &str, cancel: bool) -> Result<Value> {
        let job = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .find(|job| job.matches(principal, id))
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    404,
                    "WORKSPACE_JOB_NOT_FOUND",
                    "Workspace operation is not running; resume its original ID",
                )
            })?;
        if cancel {
            job.cancel.store(true, Ordering::Relaxed);
        }
        Ok(job.snapshot())
    }
    pub fn cancel_all(&self) {
        for job in self.entries.lock().unwrap().iter() {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }
    pub async fn close(&self) {
        {
            let entries = self.entries.lock().unwrap();
            self.tasks.close();
            for job in entries.iter() {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
        self.tasks.wait().await;
    }
}
