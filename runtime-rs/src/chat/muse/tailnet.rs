use super::{Transport, routes};
use crate::{
    AppState,
    error::{ApiError, Result},
};
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

const RETRY: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Peer {
    bind: SocketAddrV4,
    remote: Ipv4Addr,
}

impl Peer {
    pub(crate) fn new(local: Ipv4Addr, remote: Ipv4Addr, port: u16) -> Result<Self> {
        let tailnet = |ip: Ipv4Addr| matches!(ip.octets(), [100, 64..=127, _, _]);
        if !tailnet(local) || !tailnet(remote) || local == remote || port == 0 {
            return Err(ApiError::invalid(
                "localIp 和 vmIp 需要两个不同的 Tailscale IPv4 地址，port 需要有效的 TCP 端口",
            ));
        }
        Ok(Self {
            bind: SocketAddrV4::new(local, port),
            remote,
        })
    }
}

pub(crate) fn listening(app: &AppState, peer: Peer) -> bool {
    app.chat
        .as_ref()
        .is_some_and(|chat| *chat.muse.tailnet.lock().unwrap() == Some(peer))
}

struct Listener {
    peer: Peer,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl Listener {
    async fn stop(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

pub(crate) async fn run(app: AppState) {
    let mut active: Option<Listener> = None;
    let mut last_error = None;
    while !app.shutdown.is_cancelled() {
        let peer = match crate::companion_channels::muse_vm_peer(&app.config.runtime_root).await {
            Ok(peer) => {
                last_error = None;
                peer
            }
            Err(error) => {
                let message = error.to_string();
                if last_error.as_ref() != Some(&message) {
                    eprintln!("Muse Tailscale 配置读取失败：{message}");
                    last_error = Some(message);
                }
                None
            }
        };
        if active.as_ref().map(|listener| listener.peer) != peer {
            if let Some(listener) = active.take() {
                listener.stop().await;
            }
            if let Some(peer) = peer {
                let cancel = app.shutdown.child_token();
                let task = tokio::spawn(serve(app.clone(), peer, cancel.clone()));
                active = Some(Listener { peer, cancel, task });
            }
        }
        tokio::select! {
            _ = app.shutdown.cancelled() => break,
            _ = tokio::time::sleep(RETRY) => {}
        }
    }
    if let Some(listener) = active {
        listener.stop().await;
    }
}

async fn serve(app: AppState, peer: Peer, cancel: CancellationToken) {
    let Some(chat) = &app.chat else { return };
    let mut reported = false;
    while !cancel.is_cancelled() {
        let listener = tokio::select! {
            _ = cancel.cancelled() => return,
            result = TcpListener::bind(peer.bind) => result,
        };
        match listener {
            Ok(listener) => {
                let (desktop, guard) = routes(&app, Transport::Tailscale, &cancel);
                let router = desktop
                    .merge(crate::companion_channels::muse_qq_tailnet_router())
                    .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(
                        Duration::from_secs(45),
                    ))
                    .layer(middleware::from_fn_with_state(
                        (peer, cancel.clone()),
                        authorize,
                    ))
                    .with_state(app.clone());
                *chat.muse.tailnet.lock().unwrap() = Some(peer);
                eprintln!("Muse Tailscale 已监听 {}", peer.bind);
                let server = axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(cancel.clone().cancelled_owned())
                .into_future();
                tokio::pin!(server);
                tokio::select! {
                    result = &mut server => if let Err(error) = result { eprintln!("Muse Tailscale 监听中断：{error}"); },
                    _ = cancel.cancelled() => { let _ = tokio::time::timeout(Duration::from_secs(2), &mut server).await; }
                }
                drop(guard);
                *chat.muse.tailnet.lock().unwrap() = None;
                reported = false;
            }
            Err(error) if !reported => {
                eprintln!("Muse Tailscale 无法监听 {}，将重试：{error}", peer.bind);
                reported = true;
            }
            Err(_) => {}
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(RETRY) => {}
        }
    }
}

async fn authorize(
    State((peer, cancel)): State<(Peer, CancellationToken)>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    mut request: Request,
    next: Next,
) -> Response {
    let mut response = if cancel.is_cancelled()
        || remote.ip() != peer.remote
        || request.headers().contains_key(header::ORIGIN)
        || request.headers().contains_key("sec-fetch-site")
    {
        StatusCode::FORBIDDEN.into_response()
    } else {
        request.extensions_mut().insert(peer);
        next.run(request).await
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}
