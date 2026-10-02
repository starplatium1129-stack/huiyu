use super::*;
use axum::{body::Body, routing::any};
use http_body_util::BodyExt;
use std::{convert::Infallible, path::Path};
use tokio_util::sync::CancellationToken;

mod stream_lifecycle;

fn settings(root: &Path, host: &str) -> settings::Settings {
    settings::Settings {
        runtime: root.into(),
        ollama_host: host.into(),
        ollama_model: "fixture".into(),
        keep_alive: "10m".into(),
        num_predict: 300,
        num_context: 4096,
    }
}
fn input(base: &str, tools: bool) -> validation::Input {
    validation::chat(&json!({"character":"nene","provider":"api","api":{"baseUrl":format!("{base}/v1"),"model":"fixture","apiKey":"isolated"},"companionTools":tools,"messages":[{"role":"user","content":"你好"}]}),None).unwrap()
}

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    (
        format!("http://{address}"),
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }),
    )
}
async fn events(response: Response) -> Vec<Value> {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn sse(body: &str) -> Response {
    let bytes = body
        .as_bytes()
        .chunks(2)
        .map(|chunk| Ok::<Bytes, Infallible>(Bytes::copy_from_slice(chunk)))
        .collect::<Vec<_>>();
    (
        [("content-type", "text/event-stream")],
        Body::from_stream(futures_util::stream::iter(bytes)),
    )
        .into_response()
}

#[tokio::test]
async fn compatible_stream_preserves_reasoning_tokens_and_complete_tool_batches() {
    let router=Router::new().route("/v1/chat/completions",any(|Json(body):Json<Value>|async move{
        assert_eq!(body["tools"].as_array().unwrap().len(),8);
        sse(concat!("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想一下\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\",\"tool_calls\":[{\"index\":0,\"id\":\"call1\",\"function\":{\"name\":\"read_\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"file\",\"arguments\":\"\\\"note.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
            "data: [DONE]\n"))
    }));
    let (host, server) = serve(router).await;
    let directory = tempfile::tempdir().unwrap();
    let transport = transport::Transport::new();
    let prepared = compatible::prepare(
        &transport,
        &settings(directory.path(), &host),
        &input(&host, true),
        false,
    )
    .await
    .unwrap();
    let events = events(stream::response(prepared, CancellationToken::new())).await;
    assert_eq!(
        events
            .iter()
            .map(|v| v["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["meta", "reasoning", "token", "tool-call", "done"]
    );
    assert_eq!(events[2]["content"], "你好");
    assert_eq!(events[3]["name"], "read_file");
    assert_eq!(events[3]["reasoning"], "想一下");
    assert_eq!(events[3]["arguments"], r#"{"path":"note.txt"}"#);
    server.abort();
}

#[tokio::test]
async fn malformed_or_truncated_stream_cannot_emit_success_or_partial_tools() {
    let router=Router::new().fallback(||async{sse("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"one\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"two\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\"}}]}}]}\ndata: [DONE]\n")});
    let (host, server) = serve(router).await;
    let directory = tempfile::tempdir().unwrap();
    let client = transport::Transport::new();
    let prepared = compatible::prepare(
        &client,
        &settings(directory.path(), &host),
        &input(&host, true),
        false,
    )
    .await
    .unwrap();
    let values = events(stream::response(prepared, CancellationToken::new())).await;
    assert_eq!(values.len(), 2);
    assert_eq!(values[1]["type"], "error");
    server.abort();
    let (host, server) = serve(Router::new().fallback(|| async {
        sse("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n")
    }))
    .await;
    let prepared = compatible::prepare(
        &client,
        &settings(directory.path(), &host),
        &input(&host, false),
        false,
    )
    .await
    .unwrap();
    let values = events(stream::response(prepared, CancellationToken::new())).await;
    assert_eq!(values.last().unwrap()["type"], "error");
    assert!(!values.iter().any(|v| v["type"] == "done"));
    server.abort();
}

#[tokio::test]
async fn ollama_stream_and_abandoned_queue_entries_release_capacity() {
    let router=Router::new().route("/api/tags",get(||async{Json(json!({"models":[{"name":"fixture","capabilities":["completion"]},{"name":"embedding","capabilities":["embedding"]}]}))}))
        .route("/api/chat",post(|Json(body):Json<Value>|async move{assert_eq!(body["think"],false);"{\"message\":{\"content\":\"你好\"},\"done\":false}\n{\"done\":true}\n"}));
    let (host, server) = serve(router).await;
    let directory = tempfile::tempdir().unwrap();
    let settings = settings(directory.path(), &host);
    let client = transport::Transport::new();
    let service = ollama::Ollama::new();
    let input = validation::chat(
        &json!({"messages":[{"role":"user","content":"你好"}]}),
        None,
    )
    .unwrap();
    let first = service.prepare(&client, &settings, &input).await.unwrap();
    assert_eq!(service.queue_status()["active"], 1);
    {
        let waiting = service.prepare(&client, &settings, &input);
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), waiting.as_mut())
                .await
                .is_err()
        );
        assert_eq!(service.queue_status()["pending"], 1);
    }
    assert_eq!(service.queue_status()["pending"], 0);
    drop(first);
    let next = service.prepare(&client, &settings, &input).await.unwrap();
    let response = stream::response(next, CancellationToken::new());
    assert_eq!(events(response).await.last().unwrap()["type"], "done");
    assert_eq!(service.queue_status()["active"], 0);
    assert_eq!(service.queue_status()["pending"], 0);
    server.abort();
}

#[tokio::test]
async fn persona_and_validation_keep_original_prompt_rules_and_public_ip_boundary() {
    let body = json!({"character":"natsume","userProfile":{"callName":"  小明  ","relationship":"friend"},"memories":["喜欢咖啡","喜欢咖啡"],"messages":[{"role":"user","content":"你好"}]});
    let value = validation::chat(&body, None).unwrap();
    let system = value.messages[0]["content"].as_str().unwrap();
    assert!(system.starts_with("你正在扮演柚子社《CAFÉ STELLA"));
    assert!(system.contains("• 希望称呼：小明"));
    assert_eq!(system.matches("• 喜欢咖啡").count(), 1);
    assert!(validation::chat(&json!({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.test/private.png"}}]}]}),None).is_err());
    for address in [
        "127.0.0.1",
        "10.0.0.1",
        "100.64.0.1",
        "192.0.2.1",
        "::1",
        "::ffff:127.0.0.1",
        "2001:db8::1",
        "2002:7f00:1::",
    ] {
        assert!(!transport::public_ip(address.parse().unwrap()));
    }
    assert!(transport::public_ip("8.8.8.8".parse().unwrap()));
    assert!(transport::public_ip(
        "2606:4700:4700::1111".parse().unwrap()
    ));
    let fixture = tempfile::tempdir().unwrap();
    let runtime = fixture.path().join("runtime");
    let directory = runtime.join("live2d-imports/local_demo");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("core.moc3"), b"fixture").unwrap();
    std::fs::write(directory.join("texture.png"), b"fixture").unwrap();
    std::fs::write(directory.join("model.model3.json"), json!({"Version":3,"FileReferences":{"Moc":"core.moc3","Textures":["texture.png"],"Physics":""}}).to_string()).unwrap();
    std::fs::write(directory.join("companion.json"), json!({"character":{"id":"local_demo","personaPrompt":"本机人物"},"manifest":"model.model3.json","files":[]}).to_string()).unwrap();
    let settings = settings(&runtime, "http://127.0.0.1:1");
    assert_eq!(
        local_persona::read(&settings, fixture.path(), "local_demo")
            .await
            .as_deref(),
        Some("本机人物")
    );
    std::fs::remove_file(directory.join("texture.png")).unwrap();
    assert!(
        local_persona::read(&settings, fixture.path(), "local_demo")
            .await
            .is_none()
    );
}

#[tokio::test]
async fn host_config_roundtrip_never_publishes_secret() {
    let directory = tempfile::tempdir().unwrap();
    let settings = settings(directory.path(), "http://127.0.0.1:1");
    let api=validation::api(&json!({"baseUrl":"https://api.example.test/v1","model":"fixture","apiKey":"isolated-secret"})).unwrap();
    settings.write_host(&api).await.unwrap();
    let loaded = settings.read_host().await.unwrap();
    assert_eq!(loaded.key, "isolated-secret");
    let public = settings::public(Some(&loaded));
    assert_eq!(public["configured"], true);
    assert!(!public.to_string().contains("isolated-secret"));
    assert!(public.get("apiKey").is_none());
    let file = directory.path().join("state/chat_api_config.json");
    let before = std::fs::metadata(&file).unwrap();
    let replacement=validation::api(&json!({"baseUrl":"https://api.example.test/v1","model":"changed","apiKey":"replaced-secret"})).unwrap();
    settings.write_host(&replacement).await.unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(before.modified().unwrap())
        .unwrap();
    assert_eq!(std::fs::metadata(&file).unwrap().len(), before.len());
    assert_eq!(settings.read_host().await.unwrap().key, "replaced-secret");
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let bytes = std::fs::read(&file).unwrap();
        // A real handle without FILE_SHARE_DELETE deterministically refuses
        // replacement and deletion; readonly removal varies by Rust/Windows.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(&file)
            .unwrap();
        let failed_write = settings.write_host(&api).await;
        let failed_delete = settings.delete_host().await;
        let unchanged = std::fs::read(&file).unwrap();
        let files = std::fs::read_dir(file.parent().unwrap()).unwrap().count();
        drop(held);
        assert_eq!(failed_write.unwrap_err().code, "HOST_CONFIG_UNAVAILABLE");
        assert_eq!(failed_delete.unwrap_err().code, "HOST_CONFIG_UNAVAILABLE");
        assert_eq!(unchanged, bytes);
        assert_eq!(
            files, 1,
            "failed replacement must reclaim its temporary file"
        );
    }
    settings.delete_host().await.unwrap();
    assert!(settings.read_host().await.is_none());
}
