use super::*;
use futures_util::StreamExt;

async fn fixture(
    tokens: Option<usize>,
) -> (
    ollama::Ollama,
    stream::Prepared,
    tokio::task::JoinHandle<()>,
    String,
) {
    let body = tokens.map(|tokens| {
        format!(
            "{}{}",
            "{\"message\":{\"content\":\"token\"},\"done\":false}\n".repeat(tokens),
            "{\"done\":true}\n"
        )
    });
    let router = Router::new()
        .route(
            "/api/tags",
            get(|| async { Json(json!({"models":[{"name":"fixture"}]})) }),
        )
        .route(
            "/api/chat",
            post(move || {
                let response = match &body {
                    Some(body) => body.clone().into_response(),
                    None => Body::from_stream(futures_util::stream::pending::<
                        std::result::Result<Bytes, Infallible>,
                    >())
                    .into_response(),
                };
                std::future::ready(response)
            }),
        );
    let (host, server) = serve(router).await;
    let directory = tempfile::tempdir().unwrap();
    let service = ollama::Ollama::new();
    let input = validation::chat(
        &json!({"messages":[{"role":"user","content":"fixture"}]}),
        None,
    )
    .unwrap();
    let prepared = service
        .prepare(
            &transport::Transport::new(),
            &settings(directory.path(), &host),
            &input,
        )
        .await
        .unwrap();
    (service, prepared, server, host)
}

async fn released(service: &ollama::Ollama) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while service.queue_status()["active"] != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the retained response must not retain the Ollama permit");
    assert_eq!(service.queue_status()["pending"], 0);
}

#[tokio::test]
async fn stalled_body_times_out_releases_queue_and_preserves_error_after_buffered_events() {
    let (service, mut prepared, server, host) = fixture(Some(8)).await;
    // Keep the real queue permit, but make body readiness independent of socket
    // scheduling before advancing the timer deterministically.
    prepared.response = reqwest::Response::from(axum::http::Response::new(
        "{\"message\":{\"content\":\"token\"},\"done\":false}\n".repeat(8) + "{\"done\":true}\n",
    ));
    tokio::time::pause();
    let response = stream::response(prepared, CancellationToken::new());
    // Retain the entire body without polling it, allowing the four-slot channel
    // to fill. A timeout inside the body stream alone cannot pass this check.
    tokio::task::yield_now().await;
    assert_eq!(service.queue_status()["active"], 1);
    tokio::time::advance(Duration::from_secs(601)).await;
    tokio::time::resume();
    released(&service).await;
    let values = events(response).await;
    assert_eq!(values.first().unwrap()["type"], "meta");
    assert_eq!(values.last().unwrap()["type"], "error");
    assert_eq!(values.last().unwrap()["error"], "聊天流超时");
    assert!(!values.iter().any(|value| value["type"] == "done"));
    assert_eq!(
        values.len(),
        5,
        "four queued events precede the terminal error"
    );
    let directory = tempfile::tempdir().unwrap();
    let client = transport::Transport::new();
    let settings = settings(directory.path(), &host);
    let input = validation::chat(
        &json!({"messages":[{"role":"user","content":"retry"}]}),
        None,
    )
    .unwrap();
    let next = tokio::time::timeout(
        Duration::from_secs(2),
        service.prepare(&client, &settings, &input),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(service.queue_status()["active"], 1);
    drop(next);
    server.abort();
}

#[tokio::test]
async fn shutdown_releases_unpolled_body_and_reports_error() {
    let (service, mut prepared, server, _) = fixture(None).await;
    let shutdown = CancellationToken::new();
    let cancel = shutdown.clone();
    // Cancel during an upstream poll, after the relay's outer select has
    // checked cancellation. The blank line makes Events loop before yielding.
    let source = futures_util::stream::once(async move {
        cancel.cancel();
        Ok::<_, std::io::Error>(Bytes::from_static(b"\n"))
    })
    .chain(futures_util::stream::pending());
    prepared.response = reqwest::Response::from(axum::http::Response::new(
        reqwest::Body::wrap_stream(source),
    ));
    let response = stream::response(prepared, shutdown.clone());
    released(&service).await;
    let values = events(response).await;
    assert_eq!(values.last().unwrap()["type"], "error");
    assert!(!values.iter().any(|value| value["type"] == "done"));
    server.abort();
}

#[tokio::test]
async fn dropping_unpolled_body_releases_queue_without_cancelling_host() {
    let (service, prepared, server, _) = fixture(None).await;
    let shutdown = CancellationToken::new();
    let response = stream::response(prepared, shutdown.clone());
    drop(response);
    released(&service).await;
    assert!(!shutdown.is_cancelled());
    server.abort();
}

#[tokio::test]
async fn done_releases_queue_without_an_extra_body_poll() {
    let (service, prepared, server, _) = fixture(Some(1)).await;
    let mut body = stream::response(prepared, CancellationToken::new()).into_body();
    loop {
        let frame = body.frame().await.unwrap().unwrap();
        let value: Value = serde_json::from_slice(frame.data_ref().unwrap()).unwrap();
        if value["type"] == "done" {
            break;
        }
    }
    released(&service).await;
    drop(body);
    server.abort();
}
