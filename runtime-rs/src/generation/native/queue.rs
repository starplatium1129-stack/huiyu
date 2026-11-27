use super::*;
use std::{
    path::{Path, PathBuf},
    sync::Mutex as SyncMutex,
};

pub(crate) const MAX_PENDING: usize = 64;

#[derive(Clone)]
struct Entry {
    id: String,
    model: String,
    sequence: u64,
    keyframe: bool,
}

#[derive(Default)]
struct Schedule {
    waiting: VecDeque<Entry>,
    active: Option<Entry>,
    previous: Option<String>,
    resident: Option<String>,
    sequence: u64,
    group_through: Option<u64>,
    paused: bool,
}

impl Schedule {
    fn next(&self) -> Option<usize> {
        self.waiting.front()?;
        let Some(previous) = &self.previous else {
            return Some(self.waiting.iter().position(|e| e.keyframe).unwrap_or(0));
        };
        let Some(other) = self.waiting.iter().position(|e| &e.model != previous) else {
            return Some(0);
        };
        let through = self.group_through.unwrap_or(u64::MAX);
        Some(
            self.waiting
                .iter()
                .position(|e| &e.model == previous && e.sequence <= through)
                .unwrap_or(other),
        )
    }

    fn select(&mut self, index: usize) -> Entry {
        let entry = self.waiting.remove(index).expect("selected waiting entry");
        if self.previous.as_ref() != Some(&entry.model) {
            self.previous = Some(entry.model.clone());
            self.group_through = None;
        } else if self.waiting.iter().any(|e| e.model != entry.model) {
            // Drain the whole already-admitted group. Later arrivals cannot
            // continually extend it in front of the oldest different model.
            self.group_through.get_or_insert(self.sequence);
        } else {
            self.group_through = None;
        }
        entry
    }
}

pub(super) struct Queue {
    state: SyncMutex<Schedule>,
    changed: Notify,
    controls: Mutex<()>,
    pause_file: PathBuf,
}

impl Queue {
    pub fn open(runtime: &Path) -> Result<Arc<Self>> {
        let pause_file = runtime.join("state/native-gpu-queue.json");
        let paused = match std::fs::read(&pause_file) {
            Ok(data) => serde_json::from_slice::<bool>(&data).unwrap_or_else(|_| {
                eprintln!("invalid GPU queue settings; dispatch paused until resumed");
                true
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.into()),
        };
        Ok(Arc::new(Self {
            state: SyncMutex::new(Schedule {
                paused,
                ..Schedule::default()
            }),
            changed: Notify::new(),
            controls: Mutex::new(()),
            pause_file,
        }))
    }

    pub fn enqueue(self: &Arc<Self>, id: &str, input: &Value) -> Ticket {
        let mut state = self.state.lock().unwrap();
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        state.waiting.push_back(Entry {
            id: id.into(),
            model: model(input).into(),
            sequence,
            keyframe: input["family"] == "keyframe",
        });
        drop(state);
        self.changed.notify_waiters();
        Ticket {
            queue: self.clone(),
            id: id.into(),
        }
    }

    pub fn order(&self) -> Vec<String> {
        let state = self.state.lock().unwrap();
        let mut ids: Vec<_> = state.active.iter().map(|e| e.id.clone()).collect();
        let mut pending = Schedule {
            waiting: state.waiting.clone(),
            previous: state.previous.clone(),
            sequence: state.sequence,
            group_through: state.group_through,
            ..Schedule::default()
        };
        while let Some(i) = pending.next() {
            ids.push(pending.select(i).id);
        }
        ids
    }

    pub fn resident(&self, model: Option<String>) {
        let mut state = self.state.lock().unwrap();
        if model.is_none() && state.active.is_none() && state.waiting.is_empty() {
            state.previous = None;
            state.group_through = None;
        }
        state.resident = model;
    }
    pub fn wake_waiters(&self) {
        self.changed.notify_waiters();
    }

    pub fn snapshot(&self, blocked: bool) -> Value {
        let state = self.state.lock().unwrap();
        json!({"concurrency":1,"paused":state.paused,"blocked":blocked,"waiting":state.waiting.len(),
            "residentModel":state.resident,"activeModel":state.active.as_ref().map(|entry| &entry.model)})
    }

    pub async fn set_paused(self: &Arc<Self>, paused: bool) -> Result<()> {
        let queue = self.clone();
        // A disconnected requester cannot split the on-disk and live decision.
        tokio::spawn(async move {
            let _writing = queue.controls.lock().await;
            if queue.state.lock().unwrap().paused == paused {
                return Ok(());
            }
            let path = &queue.pause_file;
            tokio::fs::create_dir_all(path.parent().expect("native queue state directory")).await?;
            snapshots::write(path, &paused).await?;
            queue.state.lock().unwrap().paused = paused;
            queue.changed.notify_waiters();
            Ok(())
        })
        .await
        .map_err(|e| ApiError::new(503, "QUEUE_CONTROL_FAILED", e.to_string()))?
    }
}

pub(super) struct Ticket {
    queue: Arc<Queue>,
    id: String,
}

impl Ticket {
    pub async fn acquire(
        &self,
        engine: &Engine,
        token: &CancellationToken,
    ) -> Result<OwnedSemaphorePermit> {
        loop {
            let notified = self.queue.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if token.is_cancelled() {
                return Err(closed());
            }
            if engine.slot.is_closed() {
                return Err(worker::release_error());
            }
            {
                let mut state = self.queue.state.lock().unwrap();
                if !state.paused
                    && state.active.is_none()
                    && let Some(index) = state.next()
                    && state.waiting[index].id == self.id
                {
                    state.active = Some(state.select(index));
                    break;
                }
            }
            tokio::select! {
                _ = token.cancelled() => return Err(closed()),
                _ = notified => {}
            }
        }
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(closed()),
            slot = engine.slot.clone().acquire_owned() => slot.map_err(|_| worker::release_error()),
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut state = self.queue.state.lock().unwrap();
        if state
            .active
            .as_ref()
            .is_some_and(|entry| entry.id == self.id)
        {
            state.active = None;
            if state.waiting.is_empty() && state.resident.is_none() {
                state.previous = None;
                state.group_through = None;
            }
        } else {
            state.waiting.retain(|entry| entry.id != self.id);
        }
        drop(state);
        self.queue.changed.notify_waiters();
    }
}

pub(super) fn family(input: &Value) -> &str {
    input["family"].as_str().unwrap_or("anima")
}

pub(super) fn model(input: &Value) -> &str {
    input["modelId"]
        .as_str()
        .unwrap_or_else(|| family(input))
}
