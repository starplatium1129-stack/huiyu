//! HTTP behavior tests use small loopback payloads, never production installers.
use super::{cache::Cache, download};
use reqwest::{header::HeaderMap, Client};
use std::fs;
#[path = "download_test_server.rs"]
mod fixture;
use fixture::{assert_range, client, payload, seed, Reply, Root, Server, PREFIX, SIZE};

#[derive(Clone, Copy)]
enum Interruption {
    Disconnect,
    Cancel,
    Timeout,
}
async fn interrupted_download_resumes(mode: Interruption) {
    let body = payload(1);
    let mut first =
        Reply::complete(&body[..PREFIX], "\"v1\"").header("Content-Length", SIZE.to_string());
    first.stall = !matches!(mode, Interruption::Disconnect);
    let server = Server::start(vec![first, Reply::partial(&body, "\"v1\"")]);
    let root = Root::new();
    let client = client();
    let headers = HeaderMap::new();
    let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
    if matches!(mode, Interruption::Cancel) {
        let (signal, received) = tokio::sync::oneshot::channel();
        let mut signal = Some(signal);
        {
            let future = download::fetch(
                &client,
                &server.url,
                &headers,
                &mut cache,
                |downloaded, _, _| {
                    if downloaded >= PREFIX as u64 {
                        if let Some(signal) = signal.take() {
                            let _ = signal.send(());
                        }
                    }
                },
            );
            tokio::pin!(future);
            tokio::select! {
                result = &mut future => panic!("download completed before cancellation: {result:?}"),
                result = received => result.unwrap(),
            }
        } // Dropping the future is the updater command's cancellation mechanism.
    } else {
        let error = download::fetch(&client, &server.url, &headers, &mut cache, |_, _, _| {})
            .await
            .unwrap_err();
        if matches!(mode, Interruption::Timeout) {
            assert!(error.contains("超时"), "{error}");
        }
    }
    assert_eq!(cache.len().unwrap(), PREFIX as u64);
    drop(cache);
    let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
    let mut transferred = 0;
    download::fetch(&client, &server.url, &headers, &mut cache, |_, _, bytes| {
        transferred = bytes
    })
    .await
    .unwrap();
    assert_eq!(cache.bytes().unwrap(), body);
    assert_eq!(transferred, (SIZE - PREFIX) as u64);
    let requests = server.finish();
    assert_eq!(requests.len(), 2);
    assert_range(&requests[0], false);
    assert_range(&requests[1], true);
    assert_eq!(requests.iter().map(|r| r.body_bytes).sum::<usize>(), SIZE);
}
#[tokio::test]
async fn disconnect_preserves_prefix_and_transfers_only_remainder() {
    interrupted_download_resumes(Interruption::Disconnect).await;
}
#[tokio::test]
async fn cancel_preserves_prefix_and_transfers_only_remainder() {
    interrupted_download_resumes(Interruption::Cancel).await;
}
#[tokio::test]
async fn read_timeout_preserves_prefix_and_transfers_only_remainder() {
    interrupted_download_resumes(Interruption::Timeout).await;
}

#[tokio::test]
async fn ignored_range_replaces_old_prefix_with_complete_response() {
    let old = payload(1);
    let new = payload(2);
    let server = Server::start(vec![Reply::complete(&new, "\"v2\"")]);
    let root = Root::new();
    seed(&root, &server.url, &old[..PREFIX], "manifest-v1");
    let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
    let mut transferred = 0;
    download::fetch(
        &client(),
        &server.url,
        &HeaderMap::new(),
        &mut cache,
        |_, _, n| transferred = n,
    )
    .await
    .unwrap();
    assert_eq!(cache.bytes().unwrap(), new);
    assert_eq!(transferred, SIZE as u64);
    let requests = server.finish();
    assert_eq!(requests.len(), 1);
    assert_range(&requests[0], true);
    assert_eq!(requests[0].body_bytes, SIZE);
}

#[tokio::test]
async fn unusable_partial_responses_retry_once_without_appending() {
    let body = payload(2);
    let bad = || {
        Reply::new("206 Partial Content", Vec::new())
            .header("Content-Length", (SIZE - PREFIX).to_string())
            .header("ETag", "\"v1\"")
            .header(
                "Content-Range",
                format!("bytes {PREFIX}-{}/{}", SIZE - 1, SIZE),
            )
    };
    let cases = [
        ("changed ETag", bad().header("ETag", "\"v2\"")),
        ("weak ETag", bad().header("ETag", "W/\"v1\"")),
        ("416", Reply::new("416 Range Not Satisfiable", Vec::new())),
        (
            "malformed range",
            bad().header("Content-Range", "bytes invalid"),
        ),
        (
            "wrong offset",
            bad().header("Content-Range", format!("bytes 1-{}/{}", SIZE - 1, SIZE)),
        ),
        (
            "changed total",
            bad().header(
                "Content-Range",
                format!("bytes {PREFIX}-{}/{}", SIZE, SIZE + 1),
            ),
        ),
        ("wrong length", bad().header("Content-Length", "1")),
        (
            "encoded response",
            Reply::new("200 OK", Vec::new()).header("Content-Encoding", "gzip"),
        ),
    ];
    for (name, reply) in cases {
        let server = Server::start(vec![reply, Reply::complete(&body, "\"v2\"")]);
        let root = Root::new();
        seed(&root, &server.url, &payload(1)[..PREFIX], "manifest-v1");
        let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
        download::fetch(
            &client(),
            &server.url,
            &HeaderMap::new(),
            &mut cache,
            |_, _, _| {},
        )
        .await
        .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(cache.bytes().unwrap(), body, "{name}");
        let requests = server.finish();
        assert_eq!(requests.len(), 2, "{name}");
        assert_range(&requests[0], true);
        assert_range(&requests[1], false);
        assert_eq!(requests[1].body_bytes, SIZE, "{name}");
    }
}

#[tokio::test]
async fn repeated_invalid_range_stops_and_invalidates_cache() {
    let bad =
        || Reply::new("206 Partial Content", Vec::new()).header("Content-Range", "bytes invalid");
    let server = Server::start(vec![bad(), bad()]);
    let root = Root::new();
    seed(&root, &server.url, &payload(1)[..PREFIX], "manifest-v1");
    let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
    assert!(download::fetch(
        &client(),
        &server.url,
        &HeaderMap::new(),
        &mut cache,
        |_, _, _| {}
    )
    .await
    .is_err());
    assert_eq!(cache.len().unwrap(), 0);
    let requests = server.finish();
    assert_eq!(requests.len(), 2);
    assert_range(&requests[0], true);
    assert_range(&requests[1], false);
}

#[tokio::test]
async fn changed_manifest_or_invalid_metadata_starts_without_range() {
    let body = payload(2);
    for mode in ["identity", "corrupt", "weak-etag", "length"] {
        let server = Server::start(vec![Reply::complete(&body, "\"v2\"")]);
        let root = Root::new();
        seed(&root, &server.url, &payload(1)[..PREFIX], "manifest-v1");
        if mode == "corrupt" {
            fs::write(root.0.join("download.json"), b"{torn metadata").unwrap();
        } else if mode != "identity" {
            let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
            if mode == "weak-etag" {
                cache.record.etag = Some("W/\"v1\"".into());
            } else {
                cache.record.total = Some(1);
            }
            cache.save().unwrap();
        }
        let identity = if mode == "identity" {
            "manifest-v2"
        } else {
            "manifest-v1"
        };
        let mut cache = Cache::open(&root.0, identity).unwrap();
        assert_eq!(cache.len().unwrap(), 0, "{mode}");
        download::fetch(
            &client(),
            &server.url,
            &HeaderMap::new(),
            &mut cache,
            |_, _, _| {},
        )
        .await
        .unwrap();
        assert_eq!(cache.bytes().unwrap(), body, "{mode}");
        let requests = server.finish();
        assert_eq!(requests.len(), 1);
        assert_range(&requests[0], false);
    }
}

#[tokio::test]
async fn redirects_resume_same_url_but_never_join_different_paths_or_queries() {
    let old = payload(1);
    let new = payload(2);
    for target in ["/asset?token=1", "/asset?token=2", "/other-asset?token=1"] {
        let changed_resource = target != "/asset?token=1";
        let mut replies = vec![
            Reply::redirect("/asset?token=1"),
            Reply::complete(&old[..PREFIX], "\"v1\"").header("Content-Length", SIZE.to_string()),
            Reply::redirect(target),
            Reply::partial(if changed_resource { &new } else { &old }, "\"v1\""),
        ];
        if changed_resource {
            replies.extend([Reply::redirect(target), Reply::complete(&new, "\"v1\"")]);
        }
        let server = Server::start(replies);
        let root = Root::new();
        let client = client();
        let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
        assert!(download::fetch(
            &client,
            &server.url,
            &HeaderMap::new(),
            &mut cache,
            |_, _, _| {}
        )
        .await
        .is_err());
        assert_eq!(cache.len().unwrap(), PREFIX as u64);
        drop(cache);
        let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
        download::fetch(
            &client,
            &server.url,
            &HeaderMap::new(),
            &mut cache,
            |_, _, _| {},
        )
        .await
        .unwrap();
        assert_eq!(
            cache.bytes().unwrap().as_slice(),
            if changed_resource {
                new.as_slice()
            } else {
                old.as_slice()
            }
        );
        let requests = server.finish();
        assert_eq!(requests.len(), if changed_resource { 6 } else { 4 });
        assert_eq!(requests[1].path, "/asset?token=1");
        assert_eq!(requests[3].path, target);
        assert_range(&requests[2], true);
        assert_range(&requests[3], true);
        if changed_resource {
            assert_range(&requests[4], false);
            assert_range(&requests[5], false);
        } else {
            assert_eq!(requests.iter().map(|r| r.body_bytes).sum::<usize>(), SIZE);
        }
    }
}

#[tokio::test]
async fn missing_validator_discards_interrupted_cache_on_reopen() {
    let body = payload(1);
    let first =
        Reply::new("200 OK", body[..PREFIX].to_vec()).header("Content-Length", SIZE.to_string());
    let server = Server::start(vec![first, Reply::complete(&body, "\"v1\"")]);
    let root = Root::new();
    let client = client();
    let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
    assert!(download::fetch(
        &client,
        &server.url,
        &HeaderMap::new(),
        &mut cache,
        |_, _, _| {}
    )
    .await
    .is_err());
    assert_eq!(cache.len().unwrap(), PREFIX as u64);
    drop(cache);
    let mut cache = Cache::open(&root.0, "manifest-v1").unwrap();
    assert_eq!(cache.len().unwrap(), 0);
    download::fetch(
        &client,
        &server.url,
        &HeaderMap::new(),
        &mut cache,
        |_, _, _| {},
    )
    .await
    .unwrap();
    assert_eq!(cache.bytes().unwrap(), body);
    let requests = server.finish();
    assert_eq!(requests.len(), 2);
    assert_range(&requests[1], false);
    assert_eq!(
        requests.iter().map(|r| r.body_bytes).sum::<usize>(),
        SIZE + PREFIX
    );
}

#[tokio::test]
async fn production_client_refuses_plain_http() {
    let server = Server::start(Vec::new());
    let client = download::configure_client(Client::builder())
        .no_proxy()
        .build()
        .unwrap();
    let error = client.get(server.url.clone()).send().await.unwrap_err();
    assert!(
        error.is_builder(),
        "HTTPS-only validation must reject before connecting: {error}"
    );
    assert!(server.finish().is_empty());
}
