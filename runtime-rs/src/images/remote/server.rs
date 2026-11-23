use super::super::*;
use super::{COMPLETION_HEADER, COMPLETION_WAIT, UploadIndex, guide, upload_index};
use axum::{
    Extension, Router,
    extract::{ConnectInfo, OriginalUri, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    serve::ListenerExt,
};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::sync::Semaphore;

static LISTENING: AtomicBool = AtomicBool::new(false);

pub(crate) fn listening() -> bool {
    LISTENING.load(Ordering::Acquire)
}

async fn authorize(State(key): State<Arc<String>>, mut request: Request, next: Next) -> Response {
    let supplied = request
        .headers()
        .get("x-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // This interface is for another runtime, not browser cross-origin requests.
    let path = request.uri().path();
    let private = path.starts_with("/api/muse/qq/")
        || path.starts_with("/api/muse/desktop/")
        || path.starts_with("/api/muse/voice/");
    let inbox = request.method() == axum::http::Method::GET
        && matches!(path, "/api/muse/desktop/inbox" | "/api/muse/qq/inbox");
    let allowed = ((inbox || request.uri().query().is_none())
        && (super::relay::qq_route(request.method(), path)
            || super::relay::desktop_chat_route(request.method(), path)
            || super::relay::voice_route(request.method(), path)))
        || ["/api/anima/", "/api/creative/", "/api/qwen/", "/api/moss/"]
            .iter()
            .any(|prefix| path.starts_with(prefix))
        || matches!(
            path,
            "/api/muse/catalog"
                | "/api/muse/jobs"
                | "/api/muse/queue"
                | "/api/muse/batches"
                | guide::PATH
                | upload_index::PATH
        )
        || path.starts_with("/api/muse/catalog/")
        || path.starts_with("/api/muse/batches/");
    let mut response = if !allowed {
        StatusCode::NOT_FOUND.into_response()
    } else if !crate::remote_content::token_matches(&key, supplied)
        || request.headers().contains_key("origin")
        || request.headers().contains_key("sec-fetch-site")
    {
        StatusCode::UNAUTHORIZED.into_response()
    } else {
        // The listener is reached through a loopback TCP forwarder. Mark every
        // authenticated request as remote so it cannot inherit local ownership
        // or bypass input ownership and rate limits.
        request.headers_mut().insert(
            "x-forwarded-for",
            axum::http::HeaderValue::from_static("127.0.0.1"),
        );
        next.run(request).await
    };
    response.headers_mut().insert(
        "x-huiyu-image-protocol",
        axum::http::HeaderValue::from_static("1"),
    );
    if private {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
    }
    if response.status().is_success() {
        response
            .headers_mut()
            .insert(COMPLETION_HEADER, HeaderValue::from_static("1"));
        response
            .headers_mut()
            .append(header::LINK, HeaderValue::from_static(guide::LINK));
    }
    response
}

async fn completion(
    State(state): State<crate::AppState>,
    Extension(slots): Extension<Arc<Semaphore>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Path((_, key)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response> {
    state.host.check_running()?;
    let status = if let Ok(_slot) = slots.try_acquire() {
        let images = state.images.as_ref().ok_or_else(closed)?;
        let owner = generation::request_owner(&headers, peer, &query);
        if let Some((receipt, ready)) = images
            .wait_request_completion(&key, &owner, http::family(&uri), COMPLETION_WAIT)
            .await?
        {
            let status = if ready {
                StatusCode::NO_CONTENT
            } else {
                StatusCode::ACCEPTED
            };
            if query.get("receipt").is_some_and(|value| value == "1")
                && (ready || query.get("progress").is_some_and(|value| value == "1"))
            {
                let mut value = images.receipt_value(receipt).await?;
                value["found"] = json!(true);
                return Ok(http::response(
                    Ok(value),
                    if ready { StatusCode::OK } else { status },
                ));
            }
            status
        } else {
            StatusCode::ACCEPTED
        }
    } else {
        StatusCode::ACCEPTED
    };
    Ok((status, [(header::CACHE_CONTROL, "no-store")]).into_response())
}

pub(crate) async fn start(state: crate::AppState) -> Option<tokio::task::JoinHandle<()>> {
    let images = state.images.as_ref()?.clone();
    let settings = images.backend.native_settings().ok()?;
    if !settings.remote_serve || settings.engine != "native" {
        return None;
    }
    let listener =
        match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, settings.remote_port))
            .await
        {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("远程绘图端口 {} 无法监听：{error}", settings.remote_port);
                return None;
            }
        };
    let archive = images.backend.remote_store().cloned();
    let (desktop_chat, desktop_guard) =
        crate::chat::muse::routes(&state, crate::chat::muse::Transport::Relay, &state.shutdown);
    let mut app = super::super::router(images.clone())
        .merge(upload_index::router())
        .layer(Extension(Arc::new(UploadIndex::new(inputs::root(
            &images.config,
            true,
        )))))
        .layer(Extension(guide::Guide))
        .merge(super::muse::router(images.clone(), state.host.clone()))
        .merge(crate::companion_channels::muse_qq_router())
        .merge(crate::voice::muse::router())
        .merge(desktop_chat)
        .route(guide::PATH, get(guide::read))
        .merge(
            Router::new()
                .route("/api/{family}/requests/{key}/completion", get(completion))
                .layer(Extension(Arc::new(Semaphore::new(16)))),
        );
    if let Some(maintenance) = &state.maintenance {
        app = app.layer(middleware::from_fn_with_state(
            (maintenance.clone(), state.shutdown.clone()),
            crate::maintenance::read_barrier,
        ));
    }
    let app = app
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::admission::track,
        ))
        .layer(middleware::from_fn_with_state(
            Arc::new(settings.remote_key.clone()),
            authorize,
        ))
        .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(
            std::time::Duration::from_secs(30),
        ))
        .with_state(state.clone())
        // The base URL advertises only the static guide. The API subtree above
        // keeps the same authentication and owner checks.
        .route("/", get(guide::read));
    let _ = images.agent_cli_endpoint.set((settings.remote_port, settings.remote_key.clone()));
    LISTENING.store(true, Ordering::Release);
    let listener = listener.tap_io(|stream| {
        if let Err(error) = stream.set_nodelay(true) {
            eprintln!("Remote image TCP_NODELAY: {error}");
        }
    });
    Some(tokio::spawn(async move {
        let _desktop_guard = desktop_guard;
        let cancel = state.shutdown.clone();
        let relay_cancel = cancel.child_token();
        let relay = tokio::spawn(super::relay::run(
            state.config.runtime_root.clone(),
            settings.remote_port,
            settings.remote_key,
            archive,
            relay_cancel.clone(),
        ));
        let result = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async move { cancel.cancelled().await })
        .await;
        relay_cancel.cancel();
        let _ = relay.await;
        LISTENING.store(false, Ordering::Release);
        if let Err(error) = result {
            eprintln!("远程绘图服务已停止：{error}");
        }
    }))
}
