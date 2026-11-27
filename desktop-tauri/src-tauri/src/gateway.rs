use crate::mutex::RecoverMutex;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "gateway_identity.rs"]
mod identity;
#[path = "gateway_host.rs"]
mod host;
mod lifecycle;
#[cfg(windows)]
#[path = "process_job.rs"]
mod job;
pub use host::profile_id;

pub const DESKTOP_GATEWAY_PROTOCOL: i64 = 1;
pub const GATEWAY_HOST: &str = "127.0.0.1";
const MAX_HEALTH_RESPONSE_BYTES: usize = 16 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1200);
const STARTUP_PROBE_INTERVAL: Duration = Duration::from_millis(80);
const STARTUP_FALLBACK_INTERVAL: Duration = Duration::from_millis(400);

#[derive(Debug, Clone)]
pub struct GatewayHealth {
    pub ok: bool,
    pub app: String,
    pub desktop_protocol: i64,
    pub desktop_proof: String,
}

pub struct GatewayHostResponse {
    pub payload: serde_json::Value,
    pub origin: String,
    pub runtime_epoch: String,
    pub owned: bool,
}

fn http_get(port: u16, path: &str, connect_timeout: Duration, challenge: &str) -> Option<String> {
    let deadline = Instant::now().checked_add(HEALTH_TIMEOUT)?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, connect_timeout).ok()?;
    stream.set_read_timeout(Some(HEALTH_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(HEALTH_TIMEOUT)).ok()?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {GATEWAY_HOST}:{port}\r\nX-AICS-Desktop-Challenge: {challenge}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        if remaining.is_zero() { return None; }
        stream.set_read_timeout(Some(remaining)).ok()?;
        let read = match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => size,
            Err(_) => return None,
        };
        if raw.len().saturating_add(read) > MAX_HEALTH_RESPONSE_BYTES { return None; }
        raw.extend_from_slice(&buffer[..read]);
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let Some(body) = text.split("\r\n\r\n").nth(1) else {
        return None;
    };
    if !text.starts_with("HTTP/1.1 200") && !text.starts_with("HTTP/1.0 200") {
        return None;
    }
    Some(body.to_string())
}

fn read_health(port: u16, timeout: Duration, challenge: &str) -> Option<GatewayHealth> {
    let body = http_get(port, "/api/health", timeout, challenge)?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    let obj = value.as_object()?;
    Some(GatewayHealth {
        ok: obj.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        app: obj.get("app").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        desktop_protocol: obj.get("desktopProtocol").and_then(|v| v.as_i64()).unwrap_or(0),
        desktop_proof: obj.get("desktopProof").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    })
}

pub fn is_desktop_gateway_compatible(health: &GatewayHealth) -> bool {
    health.ok && health.app == "ai-cg-studio" && health.desktop_protocol == DESKTOP_GATEWAY_PROTOCOL
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).is_ok()
}

fn find_available_port(start_port: u16, attempts: u16) -> Option<u16> {
    for offset in 0..attempts {
        let candidate = start_port.saturating_add(offset);
        if is_port_available(candidate) {
            return Some(candidate);
        }
    }
    None
}

/// 自有网关进程的启动、认证、停止与日志转发。
struct GatewayChild {
    process: Child,
    exit: Option<Arc<AtomicBool>>,
    #[cfg(windows)]
    _job: job::ProcessJob,
}

impl GatewayChild {
    fn exited(&mut self) -> bool {
        self.exit.as_ref().map_or_else(
            || matches!(self.process.try_wait(), Ok(Some(_))),
            |flag| flag.load(Ordering::Acquire),
        )
    }
}

pub struct GatewaySupervisor {
    cwd: std::path::PathBuf,
    runtime_path: std::path::PathBuf,
    env: Vec<(String, String)>,
    on_output: Arc<dyn Fn(&str, &str) + Send + Sync>,
    child: Mutex<Option<GatewayChild>>,
    pub(crate) child_exit: Arc<tokio::sync::Notify>,
    start_lock: tokio::sync::Mutex<()>,
    owned: AtomicBool,
    stopping: AtomicBool,
    stop_generation: AtomicU64,
    identity_token: Mutex<Option<String>>,
    authenticated_port: Mutex<Option<u16>>,
    authenticated: AtomicBool,
    active_port: Mutex<u16>,
}

impl GatewaySupervisor {
    pub fn new(
        runtime_path: std::path::PathBuf,
        cwd: std::path::PathBuf,
        port: u16,
        env: Vec<(String, String)>,
        on_output: impl Fn(&str, &str) + Send + Sync + 'static,
    ) -> Self {
        Self {
            cwd,
            runtime_path,
            env,
            on_output: Arc::new(on_output),
            child: Mutex::new(None),
            child_exit: Arc::default(),
            start_lock: tokio::sync::Mutex::new(()),
            owned: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            stop_generation: AtomicU64::new(0),
            authenticated_port: Mutex::new(None),
            authenticated: AtomicBool::new(false),
            identity_token: Mutex::new(if cfg!(debug_assertions) { std::env::var("AICS_DESKTOP_ATTACH_TOKEN").ok() } else { None }),
            active_port: Mutex::new(port),
        }
    }
    pub fn base_url(&self) -> String {
        let port = *self.active_port.recover_lock();
        format!("http://{GATEWAY_HOST}:{port}")
    }

    pub fn port(&self) -> u16 {
        *self.active_port.recover_lock()
    }

    pub fn owns_gateway(&self) -> bool {
        self.owned.load(Ordering::Relaxed)
    }

    pub fn owned_child_exited(&self) -> bool {
        let mut child = self.child.recover_lock();
        self.owns_gateway() && child.as_mut().is_none_or(GatewayChild::exited)
    }

    pub fn host_request(&self, payload: serde_json::Value) -> Result<Option<GatewayHostResponse>, String> {
        let generation = self.stop_generation.load(Ordering::SeqCst);
        let Some(secret) = self.identity_token.recover_lock().clone() else { return Ok(None); };
        let port = self.port();
        let origin = format!("http://{GATEWAY_HOST}:{port}");
        let owned = self.owns_gateway();
        let is_current = || {
            !self.stopping.load(Ordering::SeqCst)
                && self.stop_generation.load(Ordering::SeqCst) == generation
                && self.port() == port
                && self.identity_token.recover_lock().as_ref() == Some(&secret)
                && self.owns_gateway() == owned
        };
        if !is_current() { return Ok(None); }
        // Each bootstrap proves this snapshot with a fresh challenge. A cached
        // authenticated flag cannot authorize a private host action.
        let healthy = authenticated_health(port, &secret, HEALTH_TIMEOUT);
        if !is_current() { return Ok(None); }
        self.authenticated.store(healthy, Ordering::SeqCst);
        if !healthy { return Ok(None); }
        let payload = host::request(&origin, &secret, payload)?;
        if !is_current() { return Err("HOST_IDENTITY_UNAVAILABLE".into()); }
        Ok(Some(GatewayHostResponse {
            payload,
            runtime_epoch: host::epoch(&secret),
            origin,
            owned,
        }))
    }

    pub fn is_healthy(&self) -> bool {
        let healthy = self.check_authenticated_health();
        self.authenticated.store(healthy, Ordering::SeqCst);
        healthy
    }

    pub async fn is_healthy_async(&self) -> bool {
        self.probe_health(HEALTH_TIMEOUT).await
    }

    async fn probe_health(&self, connect_timeout: Duration) -> bool {
        let Some(token) = self.identity_token.recover_lock().clone() else { return false; };
        let port = self.port();
        let generation = self.stop_generation.load(Ordering::SeqCst);
        let secret = token.clone();
        let healthy = tauri::async_runtime::spawn_blocking(move || authenticated_health(port, &secret, connect_timeout))
            .await.unwrap_or(false);
        // A probe from before stop/restart cannot authenticate the replacement.
        if self.stop_generation.load(Ordering::SeqCst) != generation
            || self.port() != port
            || self.identity_token.recover_lock().as_ref() != Some(&token) {
            return false;
        }
        self.authenticated.store(healthy, Ordering::SeqCst);
        healthy
    }

    fn check_authenticated_health(&self) -> bool {
        let Some(token) = self.identity_token.recover_lock().clone() else { return false; };
        authenticated_health(self.port(), &token, HEALTH_TIMEOUT)
    }

    pub async fn start(&self) -> Result<String, String> {
        let _start_guard = self.start_lock.lock().await;
        if self.stopping.load(Ordering::Relaxed) {
            return Err("Gateway start cancelled".into());
        }
        if !self.runtime_path.is_absolute() || !self.runtime_path.is_file() {
            return Err(format!("Rust runtime executable is missing or not absolute: {}", self.runtime_path.display()));
        }
        if self.identity_token.recover_lock().as_ref().is_some_and(|token| !identity::valid_secret(token)) {
            return Err("AICS_DESKTOP_ATTACH_TOKEN must be exactly 64 lowercase hexadecimal characters".into());
        }
        let generation = self.stop_generation.load(Ordering::SeqCst);
        // 已有兼容网关 → attach
        let healthy = self.is_healthy_async().await;
        if self.stopping.load(Ordering::SeqCst) || self.stop_generation.load(Ordering::SeqCst) != generation {
            return Err("Gateway start cancelled".into());
        }
        if healthy {
            *self.authenticated_port.recover_lock() = Some(self.port());
            return Ok(self.base_url());
        }
        // A failed health check on an owned instance is a restart, not an
        // invitation to launch a second gateway on another port. Reap the old
        // child before deciding whether the configured port is available.
        if self.owns_gateway() {
            self.reap_child().await?;
        }
        #[cfg(windows)]
        if let Some((_, config)) = self.env.iter().find(|(key, _)| key == "AICS_DESKTOP_CONFIG_ROOT") {
            let config = std::path::PathBuf::from(config);
            let recovered = tauri::async_runtime::spawn_blocking(move || host::recover_exited_owner(&config))
                .await.map_err(|error| format!("gateway owner recovery worker: {error}"))??;
            if recovered {
                (self.on_output)("host", "Recovered workspace ownership after confirmed process exit");
            }
        }
        let current = *self.active_port.recover_lock();
        if !is_port_available(current) {
            let bundled = self.env.iter().any(|(key, value)| key == "AICS_DESKTOP_BUNDLED_UI" && value == "1");
            let preserve = self.env.iter().any(|(key, value)| key == "AICS_DESKTOP_PRESERVE_ORIGIN" && value == "1");
            if !bundled && (self.authenticated_port.recover_lock().is_some() || preserve) {
                return Err("Legacy profile origin is occupied; close the conflicting service before migration".into());
            }
            let next = find_available_port(current.saturating_add(1), 32)
                .ok_or("No available desktop gateway port")?;
            *self.active_port.recover_lock() = next;
        }

        let port = self.port();
        let token = identity::random_secret()?;
        *self.identity_token.recover_lock() = Some(token.clone());

        let mut command = Command::new(&self.runtime_path);
        let (ready_sender, mut ready_receiver) = tokio::sync::oneshot::channel();

        command
            .arg("--app-root").arg(&self.cwd)
            .arg("--bind").arg(format!("{GATEWAY_HOST}:{port}"))
            .current_dir(&self.cwd)
            .env("HOST", GATEWAY_HOST)
            .env("PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.env {
            command.env(key, value);
        }
        command.env("AICS_DESKTOP_GATEWAY_TOKEN", token);

        // Windows：GUI 应用（windows_subsystem=windows）派生控制台子进程时，
        // 不带 CREATE_NO_WINDOW 会为 runtime 新建一个可见的控制台窗口（打开应用即弹窗）。
        // 该标志让网关在后台无窗口运行；stdout/stderr 仍经 pipe 回传日志。
        #[cfg(windows)]
        command.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .arg("--desktop-owned").stdin(Stdio::piped());

        // Register ownership before authorizing runtime initialization. Exit
        // takes this same slot, so no startup child can escape reap_child.
        let startup = {
            let mut slot = self.child.recover_lock();
            if self.stopping.load(Ordering::SeqCst) || self.stop_generation.load(Ordering::SeqCst) != generation {
                return Err("Gateway start cancelled".into());
            }
            let mut process = command.spawn().map_err(|e| format!("spawn gateway: {e}"))?;
            #[cfg(windows)]
            let job = match job::ProcessJob::attach(&process) {
                Ok(job) => job,
                Err(error) => {
                    let _ = process.kill();
                    let _ = process.wait();
                    return Err(format!("attach gateway job: {error}"));
                }
            };
            #[cfg(windows)]
            let exit = lifecycle::watch_process_exit(&process, Arc::clone(&self.child_exit));
            #[cfg(not(windows))]
            let exit = None;
            *slot = Some(GatewayChild { process, exit, #[cfg(windows)] _job: job });
            self.owned.store(true, Ordering::Relaxed);
            let child = slot.as_mut().ok_or("gateway child unavailable")?;
            // The runtime cannot initialize or spawn model services until Windows
            // owns its descendants. EOF before this acknowledgement exits startup.
            #[cfg(windows)]
            let authorized = child.process.stdin.take()
                .ok_or_else(|| std::io::Error::other("gateway startup pipe unavailable"))
                .and_then(|mut input| input.write_all(b"owned\n"));
            #[cfg(not(windows))]
            let authorized: std::io::Result<()> = Ok(());
            authorized.map(|()| {
                if let Some(stdout) = child.process.stdout.take() {
                    pipe_output(stdout, "stdout", self.on_output.clone(), Some((self.base_url(), ready_sender)));
                }
                if let Some(stderr) = child.process.stderr.take() {
                    pipe_output(stderr, "stderr", self.on_output.clone(), None);
                }
            })
        };
        if let Err(error) = startup {
            let _ = self.reap_child().await;
            return Err(format!("authorize gateway startup: {error}"));
        }

        let started_at = Instant::now();
        let mut waiting_for_signal = true;
        loop {
            if waiting_for_signal {
                if tokio::time::timeout(STARTUP_FALLBACK_INTERVAL, &mut ready_receiver).await.is_ok() {
                    waiting_for_signal = false;
                }
            } else {
                tokio::time::sleep(STARTUP_PROBE_INTERVAL).await;
            }
            if self.stopping.load(Ordering::SeqCst) || self.stop_generation.load(Ordering::SeqCst) != generation {
                let _ = self.reap_child().await;
                return Err("Gateway start cancelled".into());
            }
            let exited = self.child.recover_lock().as_mut()
                .is_none_or(GatewayChild::exited);
            if exited {
                // 网关提前退出
                let _ = self.stop().await;
                return Err("Gateway exited during startup".into());
            }
            // The pipe wakes this probe as soon as the child serves its router.
            // Older children still work through periodic, authenticated probes.
            // A ready record never grants authority on its own.
            if self.probe_health(STARTUP_PROBE_INTERVAL).await {
                let cancelled = {
                    let _slot = self.child.recover_lock();
                    let cancelled = self.stopping.load(Ordering::SeqCst)
                        || self.stop_generation.load(Ordering::SeqCst) != generation;
                    if !cancelled {
                        *self.authenticated_port.recover_lock() = Some(port);
                    }
                    cancelled
                };
                if cancelled {
                    let _ = self.reap_child().await;
                    return Err("Gateway start cancelled".into());
                }
                return Ok(self.base_url());
            }
            if started_at.elapsed() > STARTUP_TIMEOUT {
                let _ = self.stop().await;
                return Err(format!("Gateway did not become healthy at {}", self.base_url()));
            }
        }
    }

}

fn authenticated_health(port: u16, token: &str, connect_timeout: Duration) -> bool {
    let Ok(challenge) = identity::random_secret() else { return false; };
    read_health(port, connect_timeout, &challenge)
        .map(|health| is_desktop_gateway_compatible(&health) && identity::verify_proof(token, &challenge, &health.desktop_proof))
        .unwrap_or(false)
}

fn pipe_output<R: Read + Send + 'static>(
    reader: R,
    stream: &'static str,
    on_output: Arc<dyn Fn(&str, &str) + Send + Sync>,
    mut ready: Option<(String, tokio::sync::oneshot::Sender<()>)>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = Vec::new();
        loop {
            line.clear();
            // A single log record can arrive in several pipe reads. Bound lines from native tools.
            match reader.by_ref().take(16 * 1024).read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if ready.as_ref().is_some_and(|(origin, _)| {
                        serde_json::from_slice::<serde_json::Value>(&line).is_ok_and(|value| {
                            value["event"] == "ready" && value["runtime"] == "rust"
                                && value["candidate"] == true && value["origin"].as_str() == Some(origin)
                        })
                    }) {
                        if let Some((_, signal)) = ready.take() {
                            let _ = signal.send(());
                        }
                    }
                    on_output(stream, &String::from_utf8_lossy(&line));
                }
                Err(_) => break,
            }
        }
    });
}
