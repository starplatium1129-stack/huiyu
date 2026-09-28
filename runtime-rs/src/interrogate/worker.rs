use super::{
    model::{self, Model},
    ort_runtime::{Cached, CancelRun, Control, unavailable},
    settings::Settings,
};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, oneshot};
use tokio_util::sync::CancellationToken;

pub(super) type Admission = Arc<OwnedSemaphorePermit>;
struct Work {
    image: Arc<Vec<u8>>,
    threshold: f64,
    control: Arc<Control>,
    _admission: Admission,
    reply: oneshot::Sender<Result<Value>>,
}
struct Worker {
    sender: Option<mpsc::Sender<Work>>,
    finished: Arc<AtomicBool>,
    done: Arc<Notify>,
}
#[derive(Default)]
struct State {
    closed: bool,
    worker: Option<Worker>,
    active: Option<Arc<Control>>,
}
struct Exited {
    finished: Arc<AtomicBool>,
    done: Arc<Notify>,
}
impl Drop for Exited {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        self.done.notify_waiters();
    }
}
pub(super) struct Client {
    settings: Settings,
    state: Arc<Mutex<State>>,
    gate: Arc<Semaphore>,
    validated: Arc<Mutex<Option<Model>>>,
}
impl Client {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings,
            state: Arc::new(Mutex::new(State::default())),
            gate: Arc::new(Semaphore::new(1)),
            validated: Arc::new(Mutex::new(None)),
        }
    }
    pub fn admit(&self) -> Result<Admission> {
        if self.state.lock().unwrap().closed {
            return Err(closed());
        }
        self.gate
            .clone()
            .try_acquire_owned()
            .map(Arc::new)
            .map_err(|_| ApiError::new(429, "INTERROGATE_BUSY", "WD14 正在处理另一张图片"))
    }
    fn enqueue(&self, work: Work) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(closed());
        }
        if state
            .worker
            .as_ref()
            .is_some_and(|worker| worker.finished.load(Ordering::Acquire))
        {
            state.worker = None;
        }
        if state.worker.is_none() {
            state.worker = Some(spawn(
                self.settings.clone(),
                self.validated.clone(),
                Arc::downgrade(&self.state),
            )?);
        }
        state.active = Some(work.control.clone());
        let result = state
            .worker
            .as_ref()
            .unwrap()
            .sender
            .as_ref()
            .ok_or_else(closed)?
            .send(work)
            .map_err(|_| unavailable("WD14 worker stopped"));
        if result.is_err() {
            state.active = None;
        }
        result
    }
    pub async fn run(
        &self,
        image: Arc<Vec<u8>>,
        threshold: f64,
        cancel: CancellationToken,
        admission: Admission,
    ) -> Result<Value> {
        let control = Arc::new(Control::new(cancel.child_token()));
        let _cancel = CancelRun(control.clone());
        let (reply, result) = oneshot::channel();
        self.enqueue(Work {
            image,
            threshold,
            control,
            _admission: admission,
            reply,
        })?;
        tokio::select! {
            reply=tokio::time::timeout(Duration::from_secs(60),result)=>match reply{Ok(result)=>result.map_err(|_|unavailable("WD14 worker stopped"))?,Err(_)=>Err(ApiError::new(504,"INTERROGATE_TIMEOUT","WD14 推理超过时限"))},
            _=cancel.cancelled()=>Err(ApiError::new(499,"CANCELLED","WD14 inference cancelled")),
        }
    }
    pub async fn probe(&self) -> Value {
        if self.state.lock().unwrap().closed {
            return json!({"available":false,"reason":"WD14 worker closed"});
        }
        let paths = self.settings.models.clone();
        let found = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || model::find(&paths)),
        )
        .await
        .ok()
        .and_then(std::result::Result::ok)
        .flatten();
        let Some(found) = found else {
            return json!({"available":false,"reason":"未找到 WD14 模型"});
        };
        let native = self.settings.ort.is_file() && self.settings.vips.is_file();
        let available = native && self.validated.lock().unwrap().as_ref() == Some(&found);
        json!({"available":available,"modelPresent":true,"nativeRuntimePresent":native,"model":found.name,"modelPath":found.path,"modelBytes":found.bytes,"dir":found.path.parent(),
            "reason":if available{None}else if !native{Some("WD14 native DLLs are not installed")}else{Some("发现权重；CPU 会话尚未通过推理验证")}})
    }
    pub async fn close(&self) {
        let waiting = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            if let Some(active) = &state.active {
                active.stop();
            }
            state.worker.as_mut().map(|worker| {
                worker.sender.take();
                (worker.finished.clone(), worker.done.clone())
            })
        };
        if let Some((finished, done)) = waiting {
            let wait = async {
                loop {
                    let notified = done.notified();
                    if finished.load(Ordering::Acquire) {
                        break;
                    }
                    notified.await;
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(5), wait).await;
        }
    }
}
fn spawn(
    settings: Settings,
    validated: Arc<Mutex<Option<Model>>>,
    state: Weak<Mutex<State>>,
) -> Result<Worker> {
    let (send, receive) = mpsc::channel::<Work>();
    let finished = Arc::new(AtomicBool::new(false));
    let done = Arc::new(Notify::new());
    let exited = Exited {
        finished: finished.clone(),
        done: done.clone(),
    };
    std::thread::Builder::new()
        .name("wd14-native".into())
        .spawn(move || {
            let _exited = exited;
            let mut cached: Option<Cached> = None;
            while let Ok(work) = receive.recv() {
                let result = (|| {
                    work.control.check()?;
                    let selected = model::find(&settings.models)
                        .ok_or_else(|| unavailable("未找到 WD14 模型（onnx + csv）"))?;
                    if !settings.ort.is_file() || !settings.vips.is_file() {
                        return Err(unavailable("WD14 native DLLs are not installed"));
                    }
                    if cached.as_ref().is_none_or(|cache| cache.model != selected) {
                        cached = None;
                        *validated.lock().unwrap() = None;
                        cached = Some(Cached::load(selected, &settings.ort)?);
                    }
                    work.control.check()?;
                    let cache = cached.as_mut().unwrap();
                    let result =
                        cache.infer(&work.image, &settings.vips, work.threshold, &work.control)?;
                    *validated.lock().unwrap() = Some(cache.model.clone());
                    Ok(result)
                })();
                if let Some(state) = state.upgrade() {
                    state.lock().unwrap().active = None;
                }
                let _ = work.reply.send(result);
                // The worker, not the abandoned HTTP future, owns the final native
                // admission reference until inference and tensor destruction finish.
            }
            drop(cached);
        })
        .map_err(|_| unavailable("Cannot start WD14 native worker"))?;
    Ok(Worker {
        sender: Some(send),
        finished,
        done,
    })
}
fn closed() -> ApiError {
    ApiError::new(503, "INTERROGATE_CLOSED", "WD14 worker closed")
}
