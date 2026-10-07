use super::*;
use axum::{Router, body::Body, http::Request, routing::get};
use tower::ServiceExt;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_inline_decodes_run_in_parallel_and_close_drains_both() {
    let decoder = Arc::new(Decoder::default());
    let (first_entered, first_started) = tokio::sync::oneshot::channel();
    let (first_release, first_gate) = std::sync::mpsc::channel();
    let first_decoder = decoder.clone();
    let first = tokio::spawn(async move {
        first_decoder
            .run(
                0,
                &CancellationToken::new(),
                &CancellationToken::new(),
                move || {
                    let _ = first_entered.send(());
                    first_gate.recv_timeout(Duration::from_secs(3)).unwrap();
                    Ok("first")
                },
            )
            .await
    });
    first_started.await.unwrap();
    let (second_entered, second_started) = tokio::sync::oneshot::channel();
    let (second_release, second_gate) = std::sync::mpsc::channel();
    let second_decoder = decoder.clone();
    let second = tokio::spawn(async move {
        second_decoder
            .run(
                0,
                &CancellationToken::new(),
                &CancellationToken::new(),
                move || {
                    let _ = second_entered.send(());
                    second_gate.recv_timeout(Duration::from_secs(3)).unwrap();
                    Ok("second")
                },
            )
            .await
    });
    // Both CPU calls have entered while neither gate has been released.
    second_started.await.unwrap();
    let closing = decoder.close();
    tokio::pin!(closing);
    assert!(futures_util::poll!(&mut closing).is_pending());
    assert!(
        *decoder.closed.lock().unwrap(),
        "Close has entered its lifecycle scope"
    );
    first_release.send(()).unwrap();
    assert_eq!(first.await.unwrap().unwrap(), "first");
    assert!(
        futures_util::poll!(&mut closing).is_pending(),
        "The second inline decode still belongs to shutdown"
    );
    second_release.send(()).unwrap();
    assert_eq!(second.await.unwrap().unwrap(), "second");
    tokio::time::timeout(Duration::from_secs(1), closing)
        .await
        .unwrap();
}

#[tokio::test]
async fn close_rejects_a_decode_admitted_before_worker_registration() {
    let decoder = Arc::new(Decoder {
        slots: Arc::new(Semaphore::new(1)),
        ..Default::default()
    });
    let (entered, started) = tokio::sync::oneshot::channel();
    let (resume, waiting) = tokio::sync::oneshot::channel();
    *decoder.registration_pause.lock().unwrap() = Some(RegistrationPause {
        entered,
        resume: waiting,
    });
    let decoded = Arc::new(AtomicBool::new(false));
    let observed = decoded.clone();
    let caller = decoder.clone();
    let work = tokio::spawn(async move {
        caller
            .run(
                BLOCKING_THRESHOLD,
                &CancellationToken::new(),
                &CancellationToken::new(),
                move || {
                    observed.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .await
    });
    started.await.unwrap();
    assert_eq!(decoder.slots.available_permits(), 0);
    tokio::time::timeout(Duration::from_secs(1), decoder.close())
        .await
        .unwrap();
    resume.send(()).unwrap();
    assert_eq!(work.await.unwrap().unwrap_err().code, "GENERATION_CLOSED");
    assert!(
        !decoded.load(Ordering::Acquire),
        "No CPU worker may start after close returns"
    );
    assert_eq!(decoder.slots.available_permits(), 1);
    assert_eq!(
        decoder
            .run(
                0,
                &CancellationToken::new(),
                &CancellationToken::new(),
                || Ok(())
            )
            .await
            .unwrap_err()
            .code,
        "GENERATION_CLOSED"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn bounded_cpu_work_keeps_small_requests_ready_and_releases_after_cancel() {
    let decoder = Arc::new(Decoder {
        slots: Arc::new(Semaphore::new(1)),
        ..Default::default()
    });
    let request = CancellationToken::new();
    let shutdown = CancellationToken::new();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let caller = decoder.clone();
    let cancelled = request.clone();
    let ending = shutdown.clone();
    let work = tokio::spawn(async move {
        caller
            .run(BLOCKING_THRESHOLD, &cancelled, &ending, move || {
                let _ = entered.send(());
                gate.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(json!({"decoded":true}))
            })
            .await
    });
    started.await.unwrap();
    assert_eq!(decoder.slots.available_permits(), 0);
    let light = Router::new().route("/light", get(|| async { "ready" }));
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(1),
            light.oneshot(
                Request::builder()
                    .uri("/light")
                    .body(Body::empty())
                    .unwrap()
            )
        )
        .await
        .unwrap()
        .unwrap()
        .status(),
        axum::http::StatusCode::OK
    );
    assert_eq!(
        decoder
            .json(
                "webui",
                200,
                br#"{"online":true}"#.to_vec(),
                &request,
                &shutdown
            )
            .await
            .unwrap()["online"],
        true
    );
    // A large Comfy history must share the same bounded worker admission,
    // while its tiny status replies can still use the inline path.
    let comfy_cancel = CancellationToken::new();
    let mut comfy = Box::pin(decoder.json(
        "comfy",
        200,
        serde_json::to_vec(&json!({"history":"x".repeat(BLOCKING_THRESHOLD)})).unwrap(),
        &comfy_cancel,
        &shutdown,
    ));
    assert!(futures_util::poll!(&mut comfy).is_pending());
    assert_eq!(
        decoder
            .json("comfy", 200, b"{}".to_vec(), &request, &shutdown)
            .await
            .unwrap(),
        json!({})
    );
    comfy_cancel.cancel();
    assert_eq!(comfy.await.unwrap_err().code, "ABORT_ERR");
    request.cancel();
    assert_eq!(work.await.unwrap().unwrap_err().code, "ABORT_ERR");
    assert_eq!(
        decoder.slots.available_permits(),
        0,
        "Dropped callers cannot overbook CPU workers"
    );
    let queued_cancel = CancellationToken::new();
    let queued_token = queued_cancel.clone();
    let queue = decoder.clone();
    let ending = shutdown.clone();
    let queued = tokio::spawn(async move {
        queue
            .json(
                "webui",
                200,
                serde_json::to_vec(&json!({"large":"x".repeat(BLOCKING_THRESHOLD)})).unwrap(),
                &queued_token,
                &ending,
            )
            .await
    });
    queued_cancel.cancel();
    assert_eq!(queued.await.unwrap().unwrap_err().code, "ABORT_ERR");
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while decoder.slots.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        decoder
            .json(
                "webui",
                200,
                b"{}".to_vec(),
                &CancellationToken::new(),
                &shutdown
            )
            .await
            .unwrap(),
        json!({})
    );
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let caller = decoder.clone();
    let ending = shutdown.clone();
    let work = tokio::spawn(async move {
        caller
            .run(
                BLOCKING_THRESHOLD,
                &CancellationToken::new(),
                &ending,
                move || {
                    let _ = entered.send(());
                    gate.recv_timeout(Duration::from_secs(3)).unwrap();
                    Ok(())
                },
            )
            .await
    });
    started.await.unwrap();
    shutdown.cancel();
    assert_eq!(work.await.unwrap().unwrap_err().code, "GENERATION_CLOSED");
    let finishing = decoder.clone();
    let closing = tokio::spawn(async move { finishing.close().await });
    tokio::task::yield_now().await;
    assert!(
        !closing.is_finished(),
        "Close must drain CPU workers after caller cancellation"
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), closing)
        .await
        .unwrap()
        .unwrap();
    assert!(decoder.slots.is_closed());
}

#[tokio::test]
async fn json_and_image_fast_and_blocking_paths_preserve_outputs_and_bounds() {
    let decoder = Decoder::default();
    let cancel = CancellationToken::new();
    for length in [32, BLOCKING_THRESHOLD + 31] {
        let bytes = vec![42; length];
        let wire = serde_json::to_vec(
            &json!({"images":[STANDARD.encode(&bytes)],"info":"{\"seed\":123}"}),
        )
        .unwrap();
        let value = decoder
            .json("webui", 200, wire, &cancel, &cancel)
            .await
            .unwrap();
        let image = decoder.image(value, &cancel).await.unwrap();
        assert_eq!(image.bytes, bytes);
        assert_eq!(image.seed, Some(123));
    }
    assert_eq!(
        decoder
            .json(
                "webui",
                503,
                b"provider unavailable".to_vec(),
                &cancel,
                &cancel
            )
            .await
            .unwrap(),
        json!("provider unavailable")
    );
    assert_eq!(
        decoder
            .json("webui", 200, b"invalid".to_vec(), &cancel, &cancel)
            .await
            .unwrap_err()
            .code,
        "INVALID_UPSTREAM_RESPONSE"
    );
    assert_eq!(
        decoder
            .json("comfy", 200, b"invalid".to_vec(), &cancel, &cancel)
            .await
            .unwrap_err()
            .code,
        "COMFY_INVALID_RESPONSE"
    );
    assert_eq!(
        decoder
            .json(
                "webui",
                200,
                vec![0; constants::MAX_JSON + 1],
                &cancel,
                &cancel
            )
            .await
            .unwrap_err()
            .code,
        "UPSTREAM_RESPONSE_TOO_LARGE"
    );
    assert_eq!(
        decoder
            .image(json!({"images":["***"]}), &cancel)
            .await
            .err()
            .unwrap()
            .code,
        "SD_INVALID_IMAGE"
    );
    assert_eq!(
        decoder
            .image(json!({"images":[]}), &cancel)
            .await
            .err()
            .unwrap()
            .code,
        "SD_NO_IMAGE"
    );
    cancel.cancel();
    assert_eq!(
        decoder
            .json(
                "webui",
                200,
                b"{}".to_vec(),
                &CancellationToken::new(),
                &cancel
            )
            .await
            .unwrap_err()
            .code,
        "GENERATION_CLOSED"
    );
}
