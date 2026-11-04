use super::super::*;
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use std::sync::atomic::{AtomicBool, Ordering};

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
    let allowed = ["/api/anima/", "/api/creative/", "/api/qwen/", "/api/moss/"]
        .iter()
        .any(|prefix| request.uri().path().starts_with(prefix));
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
    response
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
    let mut app = super::super::router(images);
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
            Arc::new(settings.remote_key),
            authorize,
        ))
        .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(
            std::time::Duration::from_secs(30),
        ))
        .with_state(state.clone());
    LISTENING.store(true, Ordering::Release);
    Some(tokio::spawn(async move {
        let cancel = state.shutdown.clone();
        let result = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async move { cancel.cancelled().await })
        .await;
        LISTENING.store(false, Ordering::Release);
        if let Err(error) = result {
            eprintln!("远程绘图服务已停止：{error}");
        }
    }))
}
