use super::*;

#[tokio::test]
async fn rejected_resume_restarts_once_without_range_and_still_verifies_hash() {
    for (rejection, body, expected) in [
        (StatusCode::RANGE_NOT_SATISFIABLE, "approved", None),
        (StatusCode::PARTIAL_CONTENT, "approved", None),
        (
            StatusCode::RANGE_NOT_SATISFIABLE,
            "tampered",
            Some("CONTENT_INVALID"),
        ),
        (StatusCode::RANGE_NOT_SATISFIABLE, "", Some("HTTP_STATUS")),
    ] {
        let (directory, gateway, file, _, _) = fixture();
        let manifest = Manifest {
            entries: vec![entry("assets/a.png", b"approved")],
        };
        let raw = serde_json::to_vec(&manifest.value()).unwrap();
        let package = policy::package_identity(&raw, None);
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = requests.clone();
        let metadata = raw.clone();
        let app = Router::new()
            .route(
                "/download/manifest.json",
                get(move || async move { metadata.clone() }),
            )
            .route(
                "/download/assets/a.png",
                get(move |headers: HeaderMap| {
                    let attempt = counted.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if attempt == 0 {
                            assert_eq!(headers["range"], "bytes=3-");
                            assert_eq!(headers["if-range"], "\"old\"");
                            return (
                                rejection,
                                [("etag", "\"new\""), ("content-range", "bytes 3-7/8")],
                                "roved",
                            )
                                .into_response();
                        }
                        assert_eq!(attempt, 1, "only one clean retry is allowed");
                        assert!(!headers.contains_key("range"));
                        assert!(!headers.contains_key("if-range"));
                        (
                            if body.is_empty() {
                                rejection
                            } else {
                                StatusCode::OK
                            },
                            body,
                        )
                            .into_response()
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, app).into_future());
        let user = directory.path().join("user");
        write(&file, &serde_json::to_vec(&json!({"userDataRoot":user,"protectedRoots":[gateway.app_root],"policy":{
            "sources":{"http":{"approved":true,"kind":"http","baseUrl":format!("http://{address}/"),"loopbackFixture":true}},
            "releases":{"download":{"approved":true,"sourceId":"http","path":"download","kind":"full","packageIdentity":package,"targetIdentity":manifest.identity()}}
        }})).unwrap());
        let ctx = config::load(&gateway, &file, CancellationToken::new())
            .unwrap()
            .ctx;
        ctx.initialize().unwrap();
        let root = ctx.store.join("downloads").join(&package);
        let partial = root
            .join("parts")
            .join(format!("{}.part", digest("assets/a.png")));
        write(&partial, b"app");
        fs::write_json(&partial.with_extension("json"), &json!({"schemaVersion":1,"sha256":manifest.entries[0].sha256,"bytes":8,"etag":"\"old\""})).unwrap();
        let outcome =
            download::run(operation(&ctx), reqwest::Client::new(), "download".into()).await;
        match expected {
            None => {
                assert_eq!(outcome.unwrap()["action"], "downloaded");
                assert_eq!(
                    std::fs::read(root.join("pack/assets/a.png")).unwrap(),
                    b"approved"
                );
                assert!(root.join("complete.json").exists());
            }
            Some(code) => {
                assert_eq!(outcome.unwrap_err().code, code);
                assert!(!root.join("pack/assets/a.png").exists());
                assert!(!root.join("complete.json").exists());
                if code == "HTTP_STATUS" {
                    assert_eq!(std::fs::read(&partial).unwrap(), b"app");
                }
            }
        }
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        server.abort();
    }
}
