use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

#[derive(Default)]
pub(crate) struct Jobs {
    entries: Mutex<HashMap<(String, String), Arc<Job>>>,
    tasks: TaskTracker,
}
pub(crate) struct Job {
    input: Value,
    pub cancel: Arc<AtomicBool>,
    progress: Mutex<Value>,
    outcome: Mutex<Option<Result<Value>>>,
}
impl Job {
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
    pub fn progress(&self, phase: &str, completed: u64, total: u64) {
        *self.progress.lock().unwrap() = json!({"phase":phase,"completed":completed,"total":total});
    }
    fn snapshot(&self) -> Value {
        let outcome = self.outcome.lock().unwrap();
        let mut value = json!({"operationId":self.input["operationId"],"kind":self.input["kind"],"state":"running","progress":self.progress.lock().unwrap().clone()});
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
        let key = (principal.to_owned(), id.to_owned());
        let mut entries = self.entries.lock().unwrap();
        if self.tasks.is_closed() {
            return Err(ApiError::new(
                503,
                "SHUTTING_DOWN",
                "Workspace operations are closing",
            ));
        }
        if let Some(job) = entries.get(&key) {
            if job.input != input {
                return Err(ApiError::new(
                    409,
                    "OPERATION_CONFLICT",
                    "Operation ID has different input",
                ));
            }
            let snapshot = job.snapshot();
            if matches!(
                snapshot["state"].as_str(),
                Some("running" | "cancelling" | "succeeded")
            ) {
                return Ok(snapshot);
            }
        }
        if entries
            .values()
            .any(|job| job.outcome.lock().unwrap().is_none())
        {
            return Err(ApiError::new(
                409,
                "WORKSPACE_BUSY",
                "Another workspace operation is running",
            ));
        }
        if entries.len() >= 32 {
            entries.clear();
        }
        let job = Arc::new(Job {
            input,
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Mutex::new(json!({"phase":"preparing","completed":0,"total":0})),
            outcome: Mutex::new(None),
        });
        entries.insert(key, job.clone());
        let snapshot = job.snapshot();
        self.tasks.spawn(async move {
            let future = work(job.clone());
            tokio::pin!(future);
            let result = tokio::select! {
                result = &mut future => result,
                _ = shutdown.cancelled() => { job.cancel.store(true,Ordering::Relaxed); future.await }
            };
            *job.outcome.lock().unwrap() = Some(result);
        });
        Ok(snapshot)
    }
    pub fn status(&self, principal: &str, id: &str, cancel: bool) -> Result<Value> {
        let entries = self.entries.lock().unwrap();
        let job = entries
            .get(&(principal.to_owned(), id.to_owned()))
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
        for job in self.entries.lock().unwrap().values() {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }
    pub async fn close(&self) {
        {
            let entries = self.entries.lock().unwrap();
            self.tasks.close();
            for job in entries.values() {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
        self.tasks.wait().await;
    }
}
