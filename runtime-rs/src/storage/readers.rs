use super::*;
use std::sync::Mutex;
use tokio::sync::Semaphore;
use tokio_util::{
    sync::CancellationToken,
    task::{TaskTracker, task_tracker::TaskTrackerToken},
};

const READERS: usize = 3;

pub(super) struct Pool {
    slots: Arc<Semaphore>,
    active: Activity,
    idle: Mutex<Vec<Context>>,
}

impl Pool {
    pub(super) fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(READERS)),
            active: Activity::new(),
            idle: Mutex::default(),
        }
    }

    pub(super) async fn close(&self) {
        self.active.close().await;
        self.idle.lock().unwrap().clear();
    }
}

pub(super) struct Activity {
    active: TaskTracker,
    closed: Mutex<CancellationToken>,
}

impl Activity {
    pub(super) fn new() -> Self {
        Self {
            active: TaskTracker::new(),
            closed: Mutex::new(CancellationToken::new()),
        }
    }

    pub(super) fn begin(&self) -> Result<(TaskTrackerToken, CancellationToken)> {
        let closed = self.closed.lock().unwrap();
        if closed.is_cancelled() {
            return Err(unavailable());
        }
        // TaskTracker permits new tokens even after closure. Serialize
        // registration with close so shutdown drains every admitted reader.
        Ok((self.active.token(), closed.child_token()))
    }

    pub(super) async fn close(&self) {
        {
            let closed = self.closed.lock().unwrap();
            closed.cancel();
            self.active.close();
        }
        self.active.wait().await;
    }
}

impl Storage {
    pub(super) async fn read<T>(
        &self,
        query: impl FnOnce(&Context) -> Result<T> + Send + 'static,
    ) -> Result<T>
    where
        T: Send + 'static,
    {
        if self.sender.is_closed() {
            return Err(unavailable());
        }
        let (active, closed) = self.readers.active.begin()?;
        let permit = tokio::select! {
            biased;
            _ = closed.cancelled() => return Err(unavailable()),
            permit = self.readers.slots.clone().acquire_owned() => permit.map_err(|_| unavailable())?,
        };
        // Keeping the permit with the blocking job also bounds abandoned reads.
        let storage = self.clone();
        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let request_cancel = cancel.0.clone();
        let job = tokio::task::spawn_blocking(move || {
            let _active = active;
            let _permit = permit;
            let existing = storage.readers.idle.lock().unwrap().pop();
            let mut context = match existing {
                Some(context) => context,
                None => schema::open_reader(
                    storage.root.as_ref().clone(),
                    storage.workspace_id.to_string(),
                    storage.runtime_epoch.to_string(),
                    storage.derivatives.clone(),
                )?,
            };
            context.cancel = request_cancel;
            // The epoch check is the first read in this snapshot. Companion
            // fields, aliases and task payloads all see the same WAL revision.
            let result = (|| {
                context.check_cancel()?;
                let transaction = context.db.unchecked_transaction()?;
                let epoch: String = context
                    .db
                    .prepare_cached("SELECT value FROM meta WHERE key='writerEpoch'")?
                    .query_row([], |row| row.get(0))?;
                if epoch != context.epoch || storage.sender.is_closed() {
                    return Err(unavailable());
                }
                let value = query(&context)?;
                context.check_cancel()?;
                transaction.commit()?;
                Ok(value)
            })();
            storage.readers.idle.lock().unwrap().push(context);
            result
        });
        tokio::select! {
            biased;
            _ = closed.cancelled() => Err(unavailable()),
            result = job => result.map_err(|_| unavailable())?,
        }
    }
}
