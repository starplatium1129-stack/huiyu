use super::*;

#[tokio::test]
async fn provider_catalog_discovery_needs_no_model_and_never_generates() {
    let (host, server) = serve(Router::new().route("/v1/models", get(|headers: HeaderMap| async move {
        assert_eq!(headers["authorization"], "Bearer fixture-secret");
        Json(json!({"data":[{"id":"local-chat"},{"id":"local-chat"},{"id":""},{"id":"echo-fixture-secret"},{"name":"other-chat"}]}))
    }))).await;
    let body = json!({"baseUrl":format!("{host}/v1/chat/completions"),"model":"","apiKey":"fixture-secret"});
    assert!(
        validation::api(&body).is_err(),
        "saving still requires a model"
    );
    let api = validation::inspect_api(&body).unwrap();
    assert_eq!(api.pathname, "/v1/chat/completions");
    let catalog = compatible::inspect(&transport::Transport::new(), &api)
        .await
        .unwrap();
    assert_eq!(catalog["models"], json!(["local-chat", "other-chat"]));
    assert!(!catalog.to_string().contains("fixture-secret"));
    server.abort();
}

#[tokio::test]
async fn provider_catalog_rejects_wrong_shapes_and_redacts_failure_bodies() {
    for (status, value, code) in [
        (200, json!({"ok":true}), "INVALID_MODEL_LIST"),
        (
            401,
            json!({"error":"echo fixture-secret"}),
            "UPSTREAM_STATUS",
        ),
    ] {
        let (host, server) =
            serve(Router::new().fallback(move || async move {
                (StatusCode::from_u16(status).unwrap(), Json(value))
            }))
            .await;
        let api =
            validation::inspect_api(&json!({"baseUrl":host,"apiKey":"fixture-secret"})).unwrap();
        let error = compatible::inspect(&transport::Transport::new(), &api)
            .await
            .unwrap_err();
        assert_eq!(error.code, code);
        let bytes = error
            .into_response()
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert!(!String::from_utf8_lossy(&bytes).contains("fixture-secret"));
        server.abort();
    }
}

#[test]
fn official_provider_payloads_match_their_chat_protocols() {
    let body = |base, model| json!({"provider":"api","api":{"baseUrl":base,"model":model},"reasoning":"off","companionTools":true,"messages":[{"role":"user","content":"hello"}]});
    for (base, model, field, expected) in [
        (
            "https://api.deepseek.com",
            "deepseek-flash",
            "thinking",
            json!({"type":"disabled"}),
        ),
        (
            "https://api.openai.com/v1",
            "gpt-6-luna",
            "reasoning_effort",
            json!("none"),
        ),
        (
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "qwen3.8-flash",
            "enable_thinking",
            json!(false),
        ),
        (
            "https://api.moonshot.cn/v1",
            "kimi-k2.6",
            "thinking",
            json!({"type":"disabled"}),
        ),
    ] {
        let input = validation::chat(&body(base, model), None).unwrap();
        let Some(validation::ApiSource::Personal(api)) = &input.api else {
            panic!("personal config")
        };
        let payload = compatible::payload(&input, api);
        assert_eq!(payload[field], expected);
        assert_eq!(payload["stream"], true);
        assert!(payload["tools"].is_array());
    }
}

#[test]
fn gemini_tool_signatures_survive_stream_and_request_validation_without_extra_fields() {
    let mut decoder = compatible::Decoder::default();
    decoder.decode(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-one","function":{"name":"read_file","arguments":"{}"},"extra_content":{"google":{"thought_signature":"opaque-fixture-signature","untrusted":"drop"}}}]}}]})).unwrap();
    let event = decoder.finish().unwrap().remove(0);
    assert_eq!(event["thoughtSignature"], "opaque-fixture-signature");
    let input = validation::chat(&json!({"provider":"api","api":{"baseUrl":"https://generativelanguage.googleapis.com/v1beta/openai","model":"gemini-3.8-flash"},"messages":[{"role":"user","content":"read"},{"role":"assistant","content":"","tool_calls":[{"id":"call-one","function":{"name":"read_file","arguments":"{}"},"extra_content":{"google":{"thought_signature":event["thoughtSignature"],"untrusted":"drop"}}}]},{"role":"tool","tool_call_id":"call-one","content":"fixture"}]}),None).unwrap();
    assert_eq!(
        input.messages[2]["tool_calls"][0]["extra_content"],
        json!({"google":{"thought_signature":"opaque-fixture-signature"}})
    );
}

#[tokio::test]
async fn unsupported_protocol_combinations_fail_before_any_upstream_request() {
    let directory = tempfile::tempdir().unwrap();
    let settings = settings(directory.path(), "http://127.0.0.1:1");
    for (vendor, model, code) in [
        ("openai", "gpt-6.1-sol", "UNSUPPORTED_TOOL_MODEL"),
        ("kimi", "kimi-k3", "UNSUPPORTED_CHAT_MODEL"),
        ("kimi", "kimi-k2.7-code", "UNSUPPORTED_CHAT_MODEL"),
        ("kimi", "kimi-k2.7-code-highspeed", "UNSUPPORTED_CHAT_MODEL"),
        ("deepseek", "deepseek-flash", "UNSUPPORTED_TOOL_REASONING"),
    ] {
        let mut request = input("http://127.0.0.1:1", true);
        request.reasoning = "high".into();
        if let Some(validation::ApiSource::Personal(api)) = &mut request.api {
            api.vendor = vendor.into();
            api.model = model.into();
        }
        match compatible::prepare(
            &transport::Transport::new(),
            &settings,
            &request,
            false,
            None,
        )
        .await
        {
            Ok(_) => panic!("unsupported request must not reach transport"),
            Err(error) => assert_eq!(error.code, code),
        }
    }
}

#[test]
fn gemini_reasoning_maps_supported_levels_without_claiming_thinking_is_disabled() {
    for (model, requested, expected) in [
        ("gemini-3.8-flash", "low", "low"),
        ("gemini-3.8-flash", "medium", "medium"),
        ("gemini-3.8-flash", "high", "high"),
        ("gemini-3.8-flash", "off", "low"),
        ("gemini-2.5-pro", "off", "low"),
        ("gemini-2.5-flash", "off", "none"),
    ] {
        let input = validation::chat(&json!({"provider":"api","api":{"baseUrl":"https://generativelanguage.googleapis.com/v1beta/openai/","model":model},"reasoning":requested,"messages":[{"role":"user","content":"hello"}]}), None).unwrap();
        let Some(validation::ApiSource::Personal(api)) = &input.api else {
            panic!("personal config")
        };
        assert_eq!(
            compatible::payload(&input, api)["reasoning_effort"],
            expected
        );
    }
}

#[tokio::test]
async fn mechanical_completion_uses_selected_provider_contract_without_room_tools() {
    for (vendor, model, field, expected) in [
        ("openai", "gpt-6-luna", "reasoning_effort", json!("none")),
        (
            "deepseek",
            "deepseek-flash",
            "thinking",
            json!({"type":"disabled"}),
        ),
        (
            "gemini",
            "gemini-3.8-flash",
            "reasoning_effort",
            json!("low"),
        ),
    ] {
        let (host, server) = serve(Router::new().route(
            "/v1/chat/completions",
            any(move |Json(body): Json<Value>| async move {
                assert_eq!(body["model"], model);
                assert_eq!(body["stream"], false);
                assert_eq!(body[field], expected);
                assert!(body.get("temperature").is_none());
                assert!(body.get("tools").is_none());
                assert_eq!(
                    body["messages"],
                    json!([{"role":"user","content":"rewrite fixture"}])
                );
                Json(json!({"choices":[{"message":{"content":"rewritten fixture"}}]}))
            }),
        ))
        .await;
        let api = validation::Api {
            vendor: vendor.into(),
            model: model.into(),
            base_url: host,
            pathname: "/v1/chat/completions".into(),
            key: String::new(),
        };
        assert_eq!(
            completion::complete_api(
                &transport::Transport::new(),
                &api,
                vec![json!({"role":"user","content":"rewrite fixture"})]
            )
            .await
            .unwrap(),
            "rewritten fixture"
        );
        server.abort();
    }
}
