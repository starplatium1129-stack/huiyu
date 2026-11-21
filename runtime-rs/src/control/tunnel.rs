use super::*;
use crate::{
    AppState,
    guest_share::{READY_PATH, Share},
    processes::OwnedProcess,
};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    net::TcpListener,
    process::Command,
    sync::mpsc,
};
use uuid::Uuid;

const PUBLIC_ORIGIN_PORT: u16 = 39331;

struct ManagedTunnel {
    origin: url::Url,
    token_file: PathBuf,
}

pub(super) struct TunnelRun {
    share: Arc<Share>,
    ready: Arc<AtomicBool>,
    managed: bool,
    done: tokio::task::JoinHandle<()>,
}

async fn drain<R: AsyncRead + Unpin>(stream: Option<R>, tx: mpsc::Sender<Vec<u8>>) {
    let Some(mut stream) = stream else { return };
    let mut bytes = [0u8; 4096];
    while let Ok(n) = stream.read(&mut bytes).await {
        if n == 0 || tx.send(bytes[..n].to_vec()).await.is_err() {
            break;
        }
    }
}

fn quick_origin(buffer: &[u8]) -> Option<url::Url> {
    static URL: std::sync::LazyLock<regex::bytes::Regex> = std::sync::LazyLock::new(|| {
        regex::bytes::Regex::new(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com[ \t\r\n|]").unwrap()
    });
    let matched = URL.find(buffer)?.as_bytes();
    url::Url::parse(std::str::from_utf8(&matched[..matched.len() - 1]).ok()?).ok()
}

impl ControlService {
    pub(super) fn tunnel_path(&self) -> PathBuf {
        std::env::var_os("CLOUDFLARED_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)\cloudflared\cloudflared.exe"))
    }

    pub(super) fn tunnel_disabled(&self) -> bool {
        std::env::var("DISABLE_TUNNEL").as_deref() == Ok("1")
    }

    fn managed_tunnel(&self) -> Result<Option<ManagedTunnel>> {
        let token_file = std::env::var_os("HUIYU_SHARE_TUNNEL_TOKEN_FILE").map(PathBuf::from);
        let origin = match std::env::var("HUIYU_SHARE_HOSTNAME") {
            Ok(host) => url::Url::parse(&format!("https://{}", host.trim()))
                .ok()
                .filter(|url| {
                    url.host_str().is_some_and(|host| {
                        host.contains('.') && !host.ends_with(".trycloudflare.com")
                    }) && url
                        .host()
                        .is_some_and(|host| matches!(host, url::Host::Domain(_)))
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.port().is_none()
                        && url.path() == "/"
                        && url.query().is_none()
                        && url.fragment().is_none()
                }),
            Err(std::env::VarError::NotPresent) if token_file.is_none() => return Ok(None),
            Err(_) => None,
        }
        .ok_or_else(|| {
            ApiError::invalid("请配置 HUIYU_SHARE_HOSTNAME 为固定域名，例如 play.example.com")
        })?;
        let token_file =
            token_file.unwrap_or_else(|| self.config.runtime_root.join("state/cloudflared-token"));
        let token_file = token_file
            .canonicalize()
            .ok()
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                ApiError::new(
                    503,
                    "TUNNEL_TOKEN_FILE_MISSING",
                    "固定域名的 Cloudflare 隧道令牌文件不存在",
                )
            })?;
        Ok(Some(ManagedTunnel { origin, token_file }))
    }

    pub(super) async fn tunnel_status(&self) -> (&'static str, bool) {
        let current = self.tunnel.lock().await;
        if let Some(run) = current
            .as_ref()
            .filter(|run| !run.share.cancel.is_cancelled())
        {
            return (
                if run.ready.load(Ordering::Relaxed) {
                    "active"
                } else {
                    "connecting"
                },
                run.managed,
            );
        }
        (
            "disabled",
            std::env::var_os("HUIYU_SHARE_HOSTNAME").is_some(),
        )
    }

    pub(super) async fn share_link(&self) -> String {
        let current = self.tunnel.lock().await;
        current
            .as_ref()
            .filter(|run| !run.share.cancel.is_cancelled() && run.ready.load(Ordering::Relaxed))
            .and_then(|run| {
                run.share.origin.read().unwrap().as_ref().map(|origin| {
                    format!(
                        "{}/try#{}",
                        origin.origin().ascii_serialization(),
                        run.share.invite
                    )
                })
            })
            .unwrap_or_default()
    }

    pub(in crate::control) async fn start_tunnel(
        self: &Arc<Self>,
        state: AppState,
        restore: bool,
    ) -> Result<()> {
        let _action = self.tunnel_action.lock().await;
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new(503, "SHUTTING_DOWN", "运行时正在退出"));
        }
        if self
            .tunnel
            .lock()
            .await
            .as_ref()
            .is_some_and(|run| !run.share.cancel.is_cancelled())
        {
            return Ok(());
        }
        let saved = self.saved.read().unwrap()["guestShare"].clone();
        if restore && saved.is_null() {
            return Ok(());
        }
        if self.tunnel_disabled() {
            return Err(ApiError::new(
                409,
                "TUNNEL_DISABLED",
                "公网分享已被配置禁用",
            ));
        }
        let managed = self.managed_tunnel()?;
        let credentials = managed.as_ref().and_then(|managed| {
            if saved["origin"].as_str()? != managed.origin.origin().ascii_serialization() {
                return None;
            }
            let invite = Uuid::parse_str(saved["inviteSecret"].as_str()?).ok()?;
            let signer = Uuid::parse_str(saved["signingSecret"].as_str()?).ok()?;
            Some((invite, signer))
        });
        if restore && credentials.is_none() {
            return Ok(());
        }
        if !self.tunnel_path().is_file() {
            return Err(ApiError::new(
                503,
                "TUNNEL_UNAVAILABLE",
                "未找到 cloudflared，请安装或配置 CLOUDFLARED_PATH",
            ));
        }
        let images = state
            .images
            .clone()
            .filter(|images| !images.is_remote())
            .ok_or_else(|| {
                ApiError::new(
                    409,
                    "SHARE_LOCAL_GPU_REQUIRED",
                    "请先在控制室切换到本机 Anima 出图服务",
                )
            })?;
        let cancel = self.shutdown.child_token();
        let (invite, signer) = credentials.unwrap_or_else(|| (Uuid::new_v4(), Uuid::new_v4()));
        let share = Share::new(&state, invite.simple().to_string(), signer, cancel.clone()).await?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, PUBLIC_ORIGIN_PORT))
            .await
            .map_err(|_| {
                ApiError::new(
                    503,
                    "SHARE_PORT_UNAVAILABLE",
                    format!("好友试玩端口 {PUBLIC_ORIGIN_PORT} 已被占用"),
                )
            })?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| ApiError::new(503, "SHARE_PROBE_UNAVAILABLE", "公网连通检查无法启动"))?;
        let process = self.spawn_tunnel(managed.as_ref())?;
        if let Some(managed) = &managed
            && credentials.is_none()
        {
            self.patch(json!({"guestShare":{
                "origin":managed.origin.origin().ascii_serialization(),
                "inviteSecret":share.invite, "signingSecret":signer.simple().to_string()
            }}))
            .await?;
        }
        let ready = Arc::new(AtomicBool::new(false));
        let is_managed = managed.is_some();
        let app = share.router(state, images);
        let server_cancel = cancel.clone();
        let mut server = self.tasks.spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(server_cancel.cancelled_owned())
            .await;
        });
        let service = self.clone();
        let task_share = share.clone();
        let task_ready = ready.clone();
        let done = self.tasks.spawn(async move {
            tokio::select! {
                _ = &mut server => {},
                _ = service.supervise_tunnel(process, managed.as_ref(), &task_share, &task_ready, client) => {},
            }
            cancel.cancel();
            if !server.is_finished() && tokio::time::timeout(Duration::from_secs(3), &mut server).await.is_err() {
                server.abort();
                let _ = server.await;
            }
        });
        *self.tunnel.lock().await = Some(TunnelRun {
            share,
            ready,
            managed: is_managed,
            done,
        });
        Ok(())
    }

    fn spawn_tunnel(&self, managed: Option<&ManagedTunnel>) -> Result<OwnedProcess> {
        let mut command = Command::new(self.tunnel_path());
        command.args(["tunnel", "--no-autoupdate", "--loglevel", "info"]);
        if let Some(managed) = managed {
            command
                .args(["run", "--token-file"])
                .arg(&managed.token_file);
        } else {
            command.args(["--url", &format!("http://127.0.0.1:{PUBLIC_ORIGIN_PORT}")]);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.processes.spawn(&mut command)
    }

    async fn supervise_tunnel(
        &self,
        mut process: OwnedProcess,
        managed: Option<&ManagedTunnel>,
        share: &Share,
        ready: &AtomicBool,
        client: reqwest::Client,
    ) {
        let mut delay = 2;
        loop {
            let origin = managed.map(|managed| managed.origin.clone());
            *share.origin.write().unwrap() = origin.clone();
            let (stdout, stderr) = process.take_output();
            let (tx, mut rx) = mpsc::channel(16);
            let out = self.tasks.spawn(drain(stdout, tx.clone()));
            let err = self.tasks.spawn(drain(stderr, tx));
            let mut buffer = Vec::new();
            let mut probe = tokio::time::interval(Duration::from_secs(5));
            probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let started = Instant::now();
            let mut last_reachable = started;
            loop {
                tokio::select! {
                    _ = share.cancel.cancelled() => break,
                    chunk = rx.recv() => {
                        let Some(chunk) = chunk else { break };
                        if share.origin.read().unwrap().is_none() {
                            buffer.extend(chunk);
                            if let Some(url) = quick_origin(&buffer) {
                                *share.origin.write().unwrap() = Some(url);
                            }
                            if buffer.len() > 16384 { buffer.drain(..buffer.len() - 4096); }
                        }
                    },
                    _ = probe.tick() => {
                        if !matches!(process.exited(), Ok(None)) { break; }
                        let origin = share.origin.read().unwrap().clone();
                        if let Some(origin) = origin {
                            let connected = tokio::select! {
                                _ = share.cancel.cancelled() => break,
                                connected = public_ready(&client, origin, &share.probe) => connected,
                            };
                            let previous = ready.swap(connected, Ordering::Relaxed);
                            if connected {
                                last_reachable = Instant::now();
                                delay = 2;
                                if !previous { self.log("好友试玩已通过公网连通检查"); }
                            } else if previous {
                                self.log("好友试玩连接中断，正在恢复");
                            }
                            if last_reachable.elapsed() > Duration::from_secs(90) {
                                self.log("好友试玩持续无法访问，正在重启连接器");
                                break;
                            }
                        } else if started.elapsed() > Duration::from_secs(45) {
                            break;
                        }
                    }
                }
            }
            ready.store(false, Ordering::Relaxed);
            *share.origin.write().unwrap() = None;
            let stopped = process.stop().await.is_ok();
            out.abort();
            err.abort();
            if !stopped {
                self.log("好友试玩连接器未确认退出，已关闭试玩入口");
                break;
            }
            if share.cancel.is_cancelled() {
                break;
            }
            self.log("好友试玩连接器已退出，正在重新启动");
            loop {
                tokio::select! {
                    _ = share.cancel.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_secs(delay)) => {},
                }
                delay = (delay * 2).min(30);
                if let Ok(next) = self.spawn_tunnel(managed) {
                    process = next;
                    break;
                }
            }
        }
    }

    pub(super) async fn stop_tunnel(&self) {
        let _ = self.stop_tunnel_request(false).await;
    }

    pub(super) async fn stop_tunnel_request(&self, persist: bool) -> Result<()> {
        let _action = self.tunnel_action.lock().await;
        let run = self.tunnel.lock().await.take();
        if let Some(run) = &run {
            run.share.cancel.cancel();
        }
        let saved = if persist {
            self.patch(json!({"guestShare":null})).await
        } else {
            Ok(())
        };
        if let Some(run) = run {
            let _ = run.done.await;
        }
        saved
    }
}

async fn public_ready(client: &reqwest::Client, origin: url::Url, proof: &str) -> bool {
    let url = origin.join(READY_PATH).expect("fixed probe path");
    let Ok(mut response) = client
        .get(url)
        .header("cache-control", "no-cache")
        .send()
        .await
    else {
        return false;
    };
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > 512) {
        return false;
    }
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if body.len() + chunk.len() > 512 {
            return false;
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<Value>(&body).is_ok_and(|value| value["ready"] == proof)
}
