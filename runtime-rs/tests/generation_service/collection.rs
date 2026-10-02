use super::*;

struct BlockingCollection {
    calls: AtomicUsize,
    active: AtomicUsize,
    gate: Semaphore,
    entered: mpsc::UnboundedSender<usize>,
    fail: AtomicBool,
    output: Mutex<std::sync::Weak<Vec<u8>>>,
}
struct ActiveCollection<'a>(&'a AtomicUsize);
impl Drop for ActiveCollection<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl ExecutionHooks for BlockingCollection {
    fn checkpoint(&self, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn submitting(&self, _: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert_eq!(self.active.fetch_add(1, Ordering::SeqCst), 0);
            let _active = ActiveCollection(&self.active);
            let Output::Bytes { bytes, .. } = &outputs[0] else {
                panic!("WebUI output must retain its decoded bytes");
            };
            assert_eq!(bytes.as_ref(), &png());
            *self.output.lock().unwrap() = Arc::downgrade(bytes);
            let attempt = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            self.entered.send(attempt).unwrap();
            self.gate.acquire().await.unwrap().forget();
            drop(outputs);
            if self.fail.load(Ordering::SeqCst) {
                Err(ApiError::new(
                    503,
                    "FIXTURE_STORAGE_BUSY",
                    "Blocked storage",
                ))
            } else {
                Ok(())
            }
        })
    }
}
fn blocking_collection() -> (Arc<BlockingCollection>, mpsc::UnboundedReceiver<usize>) {
    let (entered, receiver) = mpsc::unbounded_channel();
    (
        Arc::new(BlockingCollection {
            calls: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            gate: Semaphore::new(0),
            entered,
            fail: AtomicBool::new(false),
            output: Mutex::new(std::sync::Weak::new()),
        }),
        receiver,
    )
}
async fn receive<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("fixture event timed out")
        .expect("fixture event channel closed")
}
async fn submit_webui(service: &Arc<Service>, hooks: Option<Arc<dyn ExecutionHooks>>) -> String {
    let prepared = service
        .prepare(input(1), true, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(prepared.provider, "webui");
    service
        .clone()
        .submit(prepared, "owner".into(), hooks)
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn webui_slow_collection_does_not_block_next_generation() {
    let temp = tempfile::tempdir().unwrap();
    let (state, mut started) = mock(true, false);
    let server = server(state.clone()).await;
    let service = service(&server, &temp);
    let (hooks, mut entered) = blocking_collection();
    let first = submit_webui(&service, Some(hooks.clone())).await;
    assert_eq!(receive(&mut started).await, "start:1");
    state.next_gate.try_acquire().unwrap().forget();
    let second = submit_webui(&service, None).await;
    state.gate.add_permits(1);
    assert_eq!(receive(&mut entered).await, 1);

    // Keep collection blocked: releasing GPU admission alone is insufficient
    // if the serial WebUI runner still awaits this hook.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), started.recv())
            .await
            .expect("second WebUI POST must arrive while collection gate is closed")
            .unwrap(),
        "start:2"
    );
    assert_eq!(hooks.gate.available_permits(), 0);
    assert_eq!(hooks.active.load(Ordering::SeqCst), 1);
    assert_eq!(service.get_status().await.unwrap()["pending"], 1);
    for _ in 0..3 {
        let observed = tokio::time::timeout(Duration::from_secs(1), service.query(&first, "owner"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observed.status, "running");
        assert!(!observed.settled);
        assert!(!observed.unknown);
        assert_eq!(observed.outputs.len(), 1);
    }
    // A late cancel of completed generation must not interrupt the next job.
    assert_eq!(
        service.cancel(&first, "owner").await.unwrap()["status"],
        "succeeded"
    );
    assert!(
        !temp
            .path()
            .join(format!("runtime/jobs/wai-webui/{first}.png"))
            .exists()
    );
    assert!(
        !state
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call.starts_with("interrupt:"))
    );
    assert_eq!(hooks.calls.load(Ordering::SeqCst), 1);
    state.next_gate.add_permits(1);
    settled(&service, &second, "succeeded").await;
    assert_eq!(service.get_status().await.unwrap()["pending"], 0);
    hooks.gate.add_permits(1);
    settled(&service, &first, "succeeded").await;
    assert_eq!(hooks.calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.txt_count.load(Ordering::SeqCst), 2);
    assert!(
        !temp
            .path()
            .join(format!("runtime/jobs/wai-webui/{first}.png"))
            .exists()
    );
    service.close().await;
    assert!(hooks.output.lock().unwrap().upgrade().is_none());
}

#[tokio::test]
async fn webui_close_cancels_initial_and_retry_collection() {
    for blocked_attempt in [1, 2] {
        let temp = tempfile::tempdir().unwrap();
        let (state, mut started) = mock(true, false);
        let server = server(state.clone()).await;
        let service = service(&server, &temp);
        let (hooks, mut entered) = blocking_collection();
        hooks.fail.store(true, Ordering::SeqCst);
        hooks.gate.add_permits(blocked_attempt - 1);
        let id = submit_webui(&service, Some(hooks.clone())).await;
        assert_eq!(receive(&mut started).await, "start:1");
        state.gate.add_permits(1);
        for attempt in 1..=blocked_attempt {
            assert_eq!(receive(&mut entered).await, attempt);
        }
        assert_eq!(hooks.active.load(Ordering::SeqCst), 1);
        tokio::time::timeout(Duration::from_secs(1), service.close())
            .await
            .unwrap();
        assert_eq!(hooks.active.load(Ordering::SeqCst), 0);
        assert_eq!(hooks.calls.load(Ordering::SeqCst), blocked_attempt);
        assert!(hooks.output.lock().unwrap().upgrade().is_none());
        assert!(service.result(&id, "owner").await.is_err());
        assert_eq!(state.txt_count.load(Ordering::SeqCst), 1);
        let folder = temp.path().join("runtime/jobs/wai-webui");
        assert_eq!(
            std::fs::read(folder.join(format!("{id}.png"))).unwrap(),
            png()
        );
        let record: Value =
            serde_json::from_slice(&std::fs::read(folder.join(format!("{id}.json"))).unwrap())
                .unwrap();
        assert_eq!(record["owner"], "owner");
        assert!(record["webuiResult"]["expiresAt"].is_number());
    }
}

#[tokio::test]
async fn webui_collection_keeps_finite_backoff_and_query_fallback_cancellable() {
    let temp = tempfile::tempdir().unwrap();
    let (state, mut started) = mock(true, false);
    let server = server(state.clone()).await;
    let service = service(&server, &temp);
    let (hooks, mut entered) = blocking_collection();
    hooks.fail.store(true, Ordering::SeqCst);
    let id = submit_webui(&service, Some(hooks.clone())).await;
    assert_eq!(receive(&mut started).await, "start:1");
    state.gate.add_permits(1);
    assert_eq!(receive(&mut entered).await, 1);
    tokio::time::pause();
    hooks.gate.add_permits(4);
    let beginning = tokio::time::Instant::now();
    for (attempt, seconds) in [(2, 1), (3, 3), (4, 7)] {
        assert_eq!(receive(&mut entered).await, attempt);
        let expected = Duration::from_secs(seconds);
        // Tokio rounds each timer up to its next millisecond tick, including
        // with a paused clock. Account for only that per-retry rounding.
        assert!(beginning.elapsed() >= expected);
        assert!(beginning.elapsed() <= expected + Duration::from_millis(attempt as u64 - 1));
    }
    // A finite budget leaves the result pending for explicit reconciliation.
    tokio::time::sleep(Duration::from_secs(8)).await;
    tokio::time::resume();
    assert_eq!(hooks.calls.load(Ordering::SeqCst), 4);
    assert_eq!(
        service.get_job(&id, "owner").await.unwrap()["code"],
        "RESULT_COLLECTION_PENDING"
    );
    let caller = service.clone();
    let target = id.clone();
    let query = tokio::spawn(async move { caller.query(&target, "owner").await });
    assert_eq!(receive(&mut entered).await, 5);
    let observed = service.query(&id, "owner").await.unwrap();
    assert_eq!(observed.status, "running");
    assert!(!observed.settled);
    drop(observed);
    assert_eq!(hooks.calls.load(Ordering::SeqCst), 5);
    tokio::time::timeout(Duration::from_secs(1), service.close())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), query)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(hooks.active.load(Ordering::SeqCst), 0);
    assert!(hooks.output.lock().unwrap().upgrade().is_none());
    assert_eq!(state.txt_count.load(Ordering::SeqCst), 1);
}

pub(super) async fn pending_collection(service: &Service, id: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if service.get_job(id, "owner").await.unwrap()["code"] == "RESULT_COLLECTION_PENDING" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let observed = service.query(id, "owner").await.unwrap();
    assert_eq!(observed.status, "running");
    assert!(!observed.settled);
    assert!(!observed.unknown);
    assert_eq!(observed.outputs.len(), 1);
}
pub(super) struct Hooks(pub(super) Arc<Mutex<Vec<String>>>, pub(super) AtomicBool);
impl ExecutionHooks for Hooks {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert!(value["gatewayJobId"].is_string());
            self.0.lock().unwrap().push("checkpoint".into());
            Ok(())
        })
    }
    fn submitting(&self, provider: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert!(["comfy", "webui"].contains(&provider.as_str()));
            self.0.lock().unwrap().push("submitting".into());
            Ok(())
        })
    }
    fn observed(&self, id: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert_eq!(id, "p1");
            self.0.lock().unwrap().push("observed".into());
            Ok(())
        })
    }
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert!(!outputs[0].is_empty());
            if let Output::File { path, bytes, .. } = &outputs[0] {
                // Read on the first collection attempt, before any retry or wait.
                let saved = std::fs::read(path).unwrap();
                assert_eq!(*bytes, saved.len() as u64);
                assert_eq!(saved, png());
                assert_eq!(Sha256::digest(&saved), Sha256::digest(png()));
            }
            if self.1.load(Ordering::Relaxed) {
                self.0.lock().unwrap().push("collect:failed".into());
                return Err(ApiError::new(
                    503,
                    "FIXTURE_STORAGE_BUSY",
                    "Temporary durable collection failure",
                ));
            }
            self.0.lock().unwrap().push("collect".into());
            Ok(())
        })
    }
}
