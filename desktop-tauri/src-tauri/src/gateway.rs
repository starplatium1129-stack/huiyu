use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
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
#[cfg(windows)]
#[path = "process_job.rs"]
mod job;
pub use host::profile_id;

pub const DESKTOP_GATEWAY_PROTOCOL: i64 = 1;
pub const GATEWAY_HOST: &str = "127.0.0.1";
const MAX_HEALTH_RESPONSE_BYTES: usize = 16 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

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

fn http_get(base_url: &str, path: &str, timeout: Duration, challenge: &str) -> Option<String> {
    let host_port = base_url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string();
    let deadline = Instant::now().checked_add(timeout)?;
    let address = host_port.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&address, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nX-AICS-Desktop-Challenge: {challenge}\r\nConnection: close\r\n\r\n"
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

fn read_health(base_url: &str, timeout: Duration, challenge: &str) -> Option<GatewayHealth> {
    let body = http_get(base_url, "/api/health", timeout, challenge)?;
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

pub fn is_port_available(host: &str, port: u16) -> bool {
    TcpStream::connect((host, port)).is_err()
}

pub fn find_available_port(host: &str, start_port: u16, attempts: u16) -> Option<u16> {
    for offset in 0..attempts {
        let candidate = start_port.saturating_add(offset);
        if is_port_available(host, candidate) {
            return Some(candidate);
        }
    }
    None
}

/// 自有网关进程的启动、认证、停止与日志转发。
struct GatewayChild {
    process: Child,
    #[cfg(windows)]
    _job: job::ProcessJob,
}

pub struct GatewaySupervisor {
    cwd: std::path::PathBuf,
    runtime_path: std::path::PathBuf,
    env: Vec<(String, String)>,
    on_output: Arc<dyn Fn(&str, &str) + Send + Sync>,
    child: Mutex<Option<GatewayChild>>,
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
        let port = *self.active_port.lock().unwrap();
        format!("http://{GATEWAY_HOST}:{port}")
    }

    pub fn port(&self) -> u16 {
        *self.active_port.lock().unwrap()
    }

    pub fn owns_gateway(&self) -> bool {
        self.owned.load(Ordering::Relaxed)
    }

    pub fn host_request(&self, payload: serde_json::Value) -> Result<Option<GatewayHostResponse>, String> {
        let generation = self.stop_generation.load(Ordering::SeqCst);
        let Some(secret) = self.identity_token.lock().unwrap().clone() else { return Ok(None); };
        let origin = self.base_url();
        let owned = self.owns_gateway();
        let is_current = || {
            !self.stopping.load(Ordering::SeqCst)
                && self.stop_generation.load(Ordering::SeqCst) == generation
                && self.base_url() == origin
                && self.identity_token.lock().unwrap().as_ref() == Some(&secret)
                && self.owns_gateway() == owned
        };
        if !is_current() { return Ok(None); }
        // Each bootstrap proves this snapshot with a fresh challenge. A cached
        // authenticated flag cannot authorize a private host action.
        let healthy = authenticated_health(&origin, &secret);
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
        let Some(token) = self.identity_token.lock().unwrap().clone() else { return false; };
        let base = self.base_url();
        let generation = self.stop_generation.load(Ordering::SeqCst);
        let (target, secret) = (base.clone(), token.clone());
        let healthy = tauri::async_runtime::spawn_blocking(move || authenticated_health(&target, &secret))
            .await.unwrap_or(false);
        // A probe from before stop/restart cannot authenticate the replacement.
        if self.stop_generation.load(Ordering::SeqCst) != generation
            || self.base_url() != base
            || self.identity_token.lock().unwrap().as_ref() != Some(&token) {
            return false;
        }
        self.authenticated.store(healthy, Ordering::SeqCst);
        healthy
    }

    fn check_authenticated_health(&self) -> bool {
        let Some(token) = self.identity_token.lock().unwrap().clone() else { return false; };
        authenticated_health(&self.base_url(), &token)
    }

    pub async fn start(&self) -> Result<String, String> {
        let _start_guard = self.start_lock.lock().await;
        if self.stopping.load(Ordering::Relaxed) {
            return Err("Gateway start cancelled".into());
        }
        if !self.runtime_path.is_absolute() || !self.runtime_path.is_file() {
            return Err(format!("Rust runtime executable is missing or not absolute: {}", self.runtime_path.display()));
        }
        if self.identity_token.lock().unwrap().as_ref().is_some_and(|token| !identity::valid_secret(token)) {
            return Err("AICS_DESKTOP_ATTACH_TOKEN must be exactly 64 lowercase hexadecimal characters".into());
        }
        let generation = self.stop_generation.load(Ordering::SeqCst);
        // 已有兼容网关 → attach
        let healthy = self.is_healthy_async().await;
        if self.stopping.load(Ordering::SeqCst) || self.stop_generation.load(Ordering::SeqCst) != generation {
            return Err("Gateway start cancelled".into());
        }
        if healthy {
            *self.authenticated_port.lock().unwrap() = Some(self.port());
            return Ok(self.base_url());
        }
        // A failed health check on an owned instance is a restart, not an
        // invitation to launch a second gateway on another port. Reap the old
        // child before deciding whether the configured port is available.
        if self.owns_gateway() {
            self.reap_child();
        }
        let current = *self.active_port.lock().unwrap();
        if !is_port_available(GATEWAY_HOST, current) {
            let bundled = self.env.iter().any(|(key, value)| key == "AICS_DESKTOP_BUNDLED_UI" && value == "1");
            let preserve = self.env.iter().any(|(key, value)| key == "AICS_DESKTOP_PRESERVE_ORIGIN" && value == "1");
            if !bundled && (self.authenticated_port.lock().unwrap().is_some() || preserve) {
                return Err("Legacy profile origin is occupied; close the conflicting service before migration".into());
            }
            let next = find_available_port(GATEWAY_HOST, current.saturating_add(1), 32)
                .ok_or("No available desktop gateway port")?;
            *self.active_port.lock().unwrap() = next;
        }

        let port = self.port();
        let token = identity::random_secret()?;
        *self.identity_token.lock().unwrap() = Some(token.clone());

        let mut command = Command::new(&self.runtime_path);

        command
            .arg("--app-root").arg(&self.cwd)
            .arg("--bind").arg(format!("{GATEWAY_HOST}:{port}"))
            .current_dir(&self.cwd)
            .env("HOST", GATEWAY_HOST)
            .env("PORT", port.to_string())
            .env("DISABLE_TUNNEL", "1")
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
        {
            let mut slot = self.child.lock().unwrap();
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
            *slot = Some(GatewayChild { process, #[cfg(windows)] _job: job });
            self.owned.store(true, Ordering::Relaxed);
            let child = slot.as_mut().unwrap();
            // The runtime cannot initialize or spawn model services until Windows
            // owns its descendants. EOF before this acknowledgement exits startup.
            #[cfg(windows)]
            if let Err(error) = child.process.stdin.take()
                .ok_or_else(|| std::io::Error::other("gateway startup pipe unavailable"))
                .and_then(|mut input| input.write_all(b"owned\n"))
            {
                drop(slot);
                self.reap_child();
                return Err(format!("authorize gateway startup: {error}"));
            }

            if let Some(stdout) = child.process.stdout.take() {
                pipe_output(stdout, "stdout", self.on_output.clone());
            }
            if let Some(stderr) = child.process.stderr.take() {
                pipe_output(stderr, "stderr", self.on_output.clone());
            }
        }

        let started_at = Instant::now();
        loop {
            if self.stopping.load(Ordering::SeqCst) || self.stop_generation.load(Ordering::SeqCst) != generation {
                self.reap_child();
                return Err("Gateway start cancelled".into());
            }
            let exited = self.child.lock().unwrap().as_mut()
                .is_none_or(|child| matches!(child.process.try_wait(), Ok(Some(_))));
            if exited {
                // 网关提前退出
                let _ = self.stop().await;
                return Err("Gateway exited during startup".into());
            }
            if self.is_healthy_async().await {
                let slot = self.child.lock().unwrap();
                if self.stopping.load(Ordering::SeqCst) || self.stop_generation.load(Ordering::SeqCst) != generation {
                    drop(slot);
                    self.reap_child();
                    return Err("Gateway start cancelled".into());
                }
                *self.authenticated_port.lock().unwrap() = Some(port);
                return Ok(self.base_url());
            }
            if started_at.elapsed() > STARTUP_TIMEOUT {
                let _ = self.stop().await;
                return Err(format!("Gateway did not become healthy at {}", self.base_url()));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    fn reap_child(&self) {
        self.authenticated.store(false, Ordering::SeqCst);
        let child = self.child.lock().unwrap().take();
        self.owned.store(false, Ordering::Relaxed);
        if let Some(mut child) = child {
            let config = self.env.iter().find(|(key, _)| key == "AICS_DESKTOP_CONFIG_ROOT")
                .map(|(_, value)| std::path::PathBuf::from(value));
            let snapshot = config.as_ref().and_then(|root| host::owner_snapshot(root, child.process.id()));
            if let (Some(profile), Some(secret)) = (self.env.iter().find(|(key, _)| key == "AICS_DESKTOP_SOURCE_PROFILE_ID"), self.identity_token.lock().unwrap().clone()) {
                let _ = host::request(&self.base_url(), &secret, serde_json::json!({
                    "action": "shutdown", "windowId": "atelier", "origin": self.base_url(), "sourceProfileId": profile.1,
                }));
            }
            terminate_child(&mut child);
            // Startup may create the owner after the pre-shutdown snapshot.
            // Keep the exact Child handle until this final identity read/release.
            let snapshot = snapshot.or_else(|| config.as_ref().and_then(|root| host::owner_snapshot(root, child.process.id())));
            host::release_exited_owner(snapshot, &mut child.process);
        }
    }

    async fn stop(&self) {
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        self.reap_child();
    }

    /// Deployment requires a positive authenticated drain receipt. A timeout
    /// retains the child and its owner for repair; it never authorizes install.
    pub async fn maintenance_stop(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::SeqCst);
        let _start_guard = self.start_lock.lock().await;
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        if !self.owns_gateway() { return Err("MAINTENANCE_REQUIRES_OWNED_GATEWAY".into()); }
        let secret = self.identity_token.lock().unwrap().clone().ok_or("HOST_IDENTITY_UNAVAILABLE")?;
        let profile = self.env.iter().find(|(key, _)| key == "AICS_DESKTOP_SOURCE_PROFILE_ID").ok_or("HOST_PROFILE_UNAVAILABLE")?;
        if !self.is_healthy_async().await { return Err("HOST_IDENTITY_UNAVAILABLE".into()); }
        let drained = host::request(&self.base_url(), &secret, serde_json::json!({
            "action":"shutdown", "windowId":"atelier", "origin":self.base_url(), "sourceProfileId":profile.1,
        }))?;
        if drained["closed"] != true { return Err("MAINTENANCE_DRAIN_UNCONFIRMED".into()); }
        let mut slot = self.child.lock().unwrap();
        let child = slot.as_mut().ok_or("MAINTENANCE_CHILD_MISSING")?;
        // The retained Child handle proves ownership. The gateway has finished
        // durable writes and released its lease before this process is reaped.
        terminate_child(child);
        if child.process.try_wait().map_err(|_| "MAINTENANCE_CHILD_WAIT")?.is_none() { return Err("MAINTENANCE_CHILD_RUNNING".into()); }
        slot.take(); self.owned.store(false, Ordering::SeqCst); self.authenticated.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// 应用退出时永久关闭启动入口，并同步停止自有网关及其进程组。
    /// 实测 app.exit(0) 不触发 managed state 的 Drop（2026-08-15），
    /// 退出清理必须由调用方在 ExitRequested 放行前显式执行。
    pub fn stop_sync(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        self.reap_child();
    }
}

fn authenticated_health(base: &str, token: &str) -> bool {
    let Ok(challenge) = identity::random_secret() else { return false; };
    read_health(base, Duration::from_millis(1200), &challenge)
        .map(|health| is_desktop_gateway_compatible(&health) && identity::verify_proof(token, &challenge, &health.desktop_proof))
        .unwrap_or(false)
}

/// 应用退出（含托盘 quit → app.exit）时清理自己拥有的网关子进程。
/// 之前缺失该清理：网关 sidecar 成为孤儿进程继续占用端口（2026-08-15 实机复现）。
/// attach 模式（owned=false）不触碰外部网关。kill 后 wait 回收句柄。
impl Drop for GatewaySupervisor {
    fn drop(&mut self) {
        self.stop_sync();
    }
}

fn terminate_child(child: &mut GatewayChild) {
    if matches!(child.process.try_wait(), Ok(Some(_))) { return; }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.process.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.process.kill();
    let _ = child.process.wait();
}

fn pipe_output<R: Read + Send + 'static>(
    mut reader: R,
    stream: &'static str,
    on_output: Arc<dyn Fn(&str, &str) + Send + Sync>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                    on_output(stream, &text);
                }
                Err(_) => break,
            }
        }
    });
}
