use super::*;
use axum::{Router, body::Body, http::StatusCode, response::IntoResponse, routing::get};
use serde_json::json;

#[test]
fn json_body_preserves_json_plain_text_and_lossy_unknown_replies() {
    for value in [
        json!(null),
        json!("tag, 标签"),
        json!(["tag"]),
        json!({"error":"busy"}),
    ] {
        assert_eq!(decode_body(serde_json::to_vec(&value).unwrap()), Ok(value));
    }
    for bytes in [b"tag, plain text".to_vec(), vec![0xff, b'a'], vec![]] {
        let expected = String::from_utf8_lossy(&bytes).into_owned();
        assert_eq!(decode_body(bytes), Err(expected));
    }
}

#[tokio::test]
async fn json_transport_preserves_http_errors_and_bounds_chunked_bodies() {
    let router = Router::new()
        .route(
            "/ok",
            get(|| async { axum::Json(json!({"models":["fixture"]})) }),
        )
        .route(
            "/error",
            get(|| async {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    axum::Json(json!({"error":"busy"})),
                )
            }),
        )
        .route(
            "/plain",
            get(|| async { (StatusCode::BAD_GATEWAY, "provider unavailable") }),
        )
        .route(
            "/chunked",
            get(|| async {
                let stream =
                    futures_util::stream::iter([Ok::<_, std::io::Error>("1234"), Ok("5678")]);
                Body::from_stream(stream).into_response()
            }),
        )
        .route(
            "/pending",
            get(|| async {
                let first = futures_util::stream::once(async { Ok::<_, std::io::Error>("{") });
                Body::from_stream(first.chain(futures_util::stream::pending())).into_response()
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = LocalUpstream::new();
    let token = CancellationToken::new();
    for (path, status, expected) in [
        ("/ok", 200, Ok(json!({"models":["fixture"]}))),
        ("/error", 503, Ok(json!({"error":"busy"}))),
        ("/plain", 502, Err("provider unavailable".to_owned())),
        ("/chunked", 200, Ok(json!(12345678))),
    ] {
        assert_eq!(
            client
                .json(&base, path, None, Duration::from_secs(2), 128, &token)
                .await
                .unwrap(),
            (status, expected)
        );
    }
    assert_eq!(
        client
            .json(&base, "/chunked", None, Duration::from_secs(2), 8, &token)
            .await
            .unwrap()
            .1,
        Ok(json!(12345678))
    );
    assert_eq!(
        client
            .json(&base, "/chunked", None, Duration::from_secs(2), 7, &token)
            .await
            .unwrap_err()
            .code,
        "UPSTREAM_TOO_LARGE"
    );
    assert_eq!(
        client
            .json(
                &base,
                "/pending",
                None,
                Duration::from_millis(30),
                128,
                &token
            )
            .await
            .unwrap_err()
            .code,
        "UPSTREAM_TIMEOUT"
    );
    let request = client.json(&base, "/pending", None, Duration::from_secs(2), 128, &token);
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        token.cancel();
    };
    let (response, ()) = tokio::join!(request, cancel);
    assert_eq!(response.unwrap_err().code, "ABORTED");
    server.abort();
}

#[test]
#[ignore = "isolated decode benchmark; run explicitly with --nocapture"]
fn json_decode_allocation_benchmark() {
    use std::{hint::black_box, time::Instant};
    fn legacy(data: Vec<u8>) -> (Option<Value>, String) {
        let raw = String::from_utf8_lossy(&data).into_owned();
        (serde_json::from_slice(&data).ok(), raw)
    }
    let payload =
        serde_json::to_vec(&json!({"catalog": "model description 标签 ".repeat(50_000)})).unwrap();
    let expected = legacy(payload.clone());
    assert_eq!(decode_body(payload.clone()).unwrap(), expected.0.unwrap());
    let mut old = Vec::new();
    let mut new = Vec::new();
    for round in 0..21 {
        for optimized in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let begin = Instant::now();
            for _ in 0..10 {
                if optimized {
                    black_box(decode_body(black_box(payload.clone()))).unwrap();
                } else {
                    black_box(legacy(black_box(payload.clone())));
                }
            }
            let elapsed = begin.elapsed().as_secs_f64() * 1000.;
            if round > 0 {
                if optimized {
                    new.push(elapsed);
                } else {
                    old.push(elapsed);
                }
            }
        }
    }
    old.sort_by(f64::total_cmp);
    new.sort_by(f64::total_cmp);
    println!(
        "{}",
        json!({"fixtureBytes":payload.len(),"iterationsPerSample":10,"samples":20,
        "legacyMedianMs":(old[9]+old[10])/2.,"optimizedMedianMs":(new[9]+new[10])/2.,
        "legacySamplesMsSorted":old,"optimizedSamplesMsSorted":new,
        "removedRawStringCapacityBytes":expected.1.capacity(),"note":"decode microbenchmark; removed capacity is the legacy raw String allocation, not process RSS"})
    );
}
