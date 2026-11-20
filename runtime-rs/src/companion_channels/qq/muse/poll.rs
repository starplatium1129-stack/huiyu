use super::*;
use crate::companion_channels::media::IMAGE_LIMIT;
use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path as RoutePath, Request},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::atomic::AtomicBool,
};
use tokio::{net::TcpListener, task::JoinHandle};

pub(super) struct Endpoint {
    bind: SocketAddrV4,
    peer: Ipv4Addr,
    pub(super) names: Nicknames,
    listening: AtomicBool,
}

#[derive(Clone)]
struct Connection {
    mailbox: Arc<Mailbox>,
    endpoint: Arc<Endpoint>,
}

impl Endpoint {
    pub(super) fn new(local: Ipv4Addr, peer: Ipv4Addr, port: u16, names: Nicknames) -> Self {
        Self {
            bind: SocketAddrV4::new(local, port),
            peer,
            names,
            listening: AtomicBool::new(false),
        }
    }

    pub(super) fn listening(&self) -> bool {
        self.listening.load(Ordering::Relaxed)
    }

    pub(super) fn start(self: &Arc<Self>, app: AppState, mailbox: Arc<Mailbox>) -> JoinHandle<()> {
        let endpoint = self.clone();
        let cancel = mailbox.cancel.clone();
        let state = Connection {
            mailbox: mailbox.clone(),
            endpoint: endpoint.clone(),
        };
        // Only this dedicated tailnet listener mounts the keyless QQ routes.
        let images = Router::new()
            .route("/replies/{request_key}/image", post(image_reply))
            .layer(DefaultBodyLimit::max(IMAGE_LIMIT));
        let actions = routes("/pending", "/replies")
            .merge(images)
            .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(
                Duration::from_secs(45),
            ))
            .layer(axum::Extension(mailbox));
        let router = Router::new()
            .nest("/qq", actions)
            .layer(middleware::from_fn_with_state(state.clone(), authorize))
            .with_state(app);
        tokio::spawn(async move {
            let mut reported = false;
            while !cancel.is_cancelled() {
                match TcpListener::bind(endpoint.bind).await {
                    Ok(listener) => {
                        endpoint.listening.store(true, Ordering::Relaxed);
                        eprintln!("Muse QQ 反向轮询已监听 {}", endpoint.bind);
                        let server = axum::serve(
                            listener,
                            router
                                .clone()
                                .into_make_service_with_connect_info::<SocketAddr>(),
                        )
                        .with_graceful_shutdown(cancel.clone().cancelled_owned())
                        .into_future();
                        tokio::pin!(server);
                        tokio::select! {
                            result = &mut server => if let Err(error) = result {eprintln!("Muse QQ 监听中断：{error}");},
                            _ = cancel.cancelled() => {let _ = tokio::time::timeout(Duration::from_secs(2), &mut server).await;}
                        }
                        endpoint.listening.store(false, Ordering::Relaxed);
                        reported = false;
                    }
                    Err(error) if !reported => {
                        eprintln!("Muse QQ 无法监听 {}，将重试：{error}", endpoint.bind);
                        reported = true;
                    }
                    Err(_) => {}
                }
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                }
            }
        })
    }
}

async fn authorize(
    State(state): State<Connection>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    // Authenticate the actual TCP peer. Forwarded headers can never grant access.
    let mut response = if peer.ip() != state.endpoint.peer
        || state.mailbox.cancel.is_cancelled()
        || request.headers().contains_key(header::ORIGIN)
        || request.headers().contains_key("sec-fetch-site")
    {
        StatusCode::FORBIDDEN.into_response()
    } else {
        next.run(request).await
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

async fn image_reply(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    RoutePath(key): RoutePath<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    let _admission = app.host.admit_owned()?;
    let entry = mailbox.entry(&key)?;
    let settings = mailbox.settings(&app).await?;
    if !settings.muse_for(entry.scope) || !allows(&settings, entry.destination()) {
        return Err(expired());
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    attachment::send(
        &app,
        &mailbox,
        &entry,
        attachment::Attachment::image(&mime, bytes)?,
        attachment::Selection::Exact,
    )
    .await?;
    Ok(Json(
        json!({"ok":true,"requestKey":entry.key,"status":"sent","kind":"image"}),
    ))
}
