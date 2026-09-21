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

pub const DESKTOP_GATEWAY_PROTOCOL: i64 = 1;
pub const GATEWAY_HOST: &str = "127.0.0.1";
const MAX_HEALTH_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct GatewayHealth {
    pub ok: bool,
    pub app: String,
    pub desktop_protocol: i64,
    pub desktop_proof: String,
}

fn http_get(base_url: &str, path: &str, timeout: Duration, challenge: Option<&str>) -> Option<String> {
    let _url = format!("{base_url}{path}");
    let host_port = base_url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string();
    let deadline = Instant::now().checked_add(timeout)?;
    let address = host_port.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&address, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let proof_header = challenge.map(|c| format!("X-AICS-Desktop-Challenge: {c}\r\n")).unwrap_or_default();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_port}\r\n{proof_header}Connection: close\r\n\r\n"
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

pub fn read_gateway_health(base_url: &str, timeout: Duration) -> Option<GatewayHealth> {
    read_health(base_url, timeout, None)
}

fn read_health(base_url: &str, timeout: Duration, challenge: Option<&str>) -> Option<GatewayHealth> {
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

/// 网关进程管理（预留字段：端口持久化/退出回调在后续版本启用）
#[allow(dead_code)]
pub struct GatewaySupervisor {
    host: String,
    port: u16,
    cwd: std::path::PathBuf,
    server_path: std::path::PathBuf,
    node_path: Option<std::path::PathBuf>,
    env: Vec<(String, String)>,
    wait_ms: u64,
    on_exit: Option<Arc<dyn Fn(i32) + Send + Sync>>,
    on_output: Option<Arc<dyn Fn(&str, &str) + Send + Sync>>,
    child: Mutex<Option<Child>>,
    start_lock: tokio::sync::Mutex<()>,
    owned: AtomicBool,
    stopping: AtomicBool,
    stop_generation: AtomicU64,
    identity_token: Mutex<Option<String>>,
    authenticated_port: Mutex<Option<u16>>,
    authenticated: AtomicBool,
    active_port: Mutex<u16>,
}

#[allow(dead_code)]
pub struct GatewaySupervisorBuilder {
    host: String,
    port: u16,
    cwd: std::path::PathBuf,
    server_path: std::path::PathBuf,
    node_path: Option<std::path::PathBuf>,
    env: Vec<(String, String)>,
    wait_ms: u64,
    on_exit: Option<Arc<dyn Fn(i32) + Send + Sync>>,
    on_output: Option<Arc<dyn Fn(&str, &str) + Send + Sync>>,
}

impl GatewaySupervisorBuilder {
    pub fn new(server_path: std::path::PathBuf, cwd: std::path::PathBuf) -> Self {
        Self {
            host: GATEWAY_HOST.to_string(),
            port: 3000,
            cwd,
            server_path,
            node_path: None,
            env: Vec::new(),
            wait_ms: 20_000,
            on_exit: None,
            on_output: None,
        }
    }

    pub fn port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    /// 打包模式优先使用 sidecar node（binaries/node-<triple>.exe）；
    /// dev 模式走系统 node。
    pub fn node_path(mut self, node_path: Option<std::path::PathBuf>) -> Self {
        self.node_path = node_path;
        self
    }

    pub fn env(mut self, env: Vec<(String, String)>) -> Self {
        self.env = env;
        self
    }

    #[allow(dead_code)]
    pub fn wait_ms(mut self, wait_ms: u64) -> Self {
        self.wait_ms = wait_ms;
        self
    }

    #[allow(dead_code)]
    pub fn on_exit(mut self, cb: impl Fn(i32) + Send + Sync + 'static) -> Self {
        self.on_exit = Some(Arc::new(cb));
        self
    }

    pub fn on_output(mut self, cb: impl Fn(&str, &str) + Send + Sync + 'static) -> Self {
        self.on_output = Some(Arc::new(cb));
        self
    }

    pub fn build(self) -> GatewaySupervisor {
        GatewaySupervisor {
            host: self.host,
            port: self.port,
            cwd: self.cwd,
            server_path: self.server_path,
            node_path: self.node_path,
            env: self.env,
            wait_ms: self.wait_ms,
            on_exit: self.on_exit,
            on_output: self.on_output,
            child: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
            owned: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            stop_generation: AtomicU64::new(0),
            authenticated_port: Mutex::new(None),
            authenticated: AtomicBool::new(false),
            identity_token: Mutex::new(if cfg!(debug_assertions) { std::env::var("AICS_DESKTOP_ATTACH_TOKEN").ok() } else { None }),
            active_port: Mutex::new(self.port),
        }
    }
}

impl GatewaySupervisor {
    pub fn base_url(&self) -> String {
        let port = *self.active_port.lock().unwrap();
        format!("http://{}:{}", self.host, port)
    }

    pub fn port(&self) -> u16 {
        *self.active_port.lock().unwrap()
    }

    pub fn owns_gateway(&self) -> bool {
        self.owned.load(Ordering::Relaxed)
    }

    pub fn is_authenticated(&self) -> bool { self.authenticated.load(Ordering::SeqCst) }

    pub fn is_healthy(&self) -> bool {
        let healthy = self.check_authenticated_health();
        self.authenticated.store(healthy, Ordering::SeqCst);
        healthy
    }

    fn check_authenticated_health(&self) -> bool {
        let Some(token) = self.identity_token.lock().unwrap().clone() else { return false; };
        let Ok(challenge) = identity::random_secret() else { return false; };
        read_health(&self.base_url(), Duration::from_millis(1200), Some(&challenge))
            .map(|h| is_desktop_gateway_compatible(&h) && identity::verify_proof(&token, &challenge, &h.desktop_proof))
            .unwrap_or(false)
    }

    pub async fn start(&self) -> Result<String, String> {
        let _start_guard = self.start_lock.lock().await;
        if self.stopping.load(Ordering::Relaxed) {
            return Err("Gateway start cancelled".into());
        }
        if self.identity_token.lock().unwrap().as_ref().is_some_and(|token| !identity::valid_secret(token)) {
            return Err("AICS_DESKTOP_ATTACH_TOKEN must be exactly 64 lowercase hexadecimal characters".into());
        }
        let generation = self.stop_generation.load(Ordering::SeqCst);
        // 已有兼容网关 → attach
        if self.is_healthy() {
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
        if !is_port_available(&self.host, current) {
            if self.authenticated_port.lock().unwrap().is_some() {
                return Err("Authenticated gateway port is occupied; restart the desktop to select a new origin".into());
            }
            let next = find_available_port(&self.host, current.saturating_add(1), 32)
                .ok_or("No available desktop gateway port")?;
            *self.active_port.lock().unwrap() = next;
        }

        let port = self.port();
        let token = identity::random_secret()?;
        *self.identity_token.lock().unwrap() = Some(token.clone());
        self.stopping.store(false, Ordering::Relaxed);


        let node = self
            .node_path
            .clone()
            .filter(|p| p.exists())
            .unwrap_or_else(|| std::path::PathBuf::from("node"));
        let mut command = Command::new(&node);
        command
            .arg(&self.server_path)
            .current_dir(&self.cwd)
            .env("HOST", &self.host)
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
        // 不带 CREATE_NO_WINDOW 会为 node.exe 新建一个可见的控制台窗口（打开应用即弹窗）。
        // 该标志让网关在后台无窗口运行；stdout/stderr 仍经 pipe 回传日志。
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = command.spawn().map_err(|e| format!("spawn gateway: {e}"))?;
        self.owned.store(true, Ordering::Relaxed);

        if let Some(on_output) = self.on_output.clone() {
            if let Some(stdout) = child.stdout.take() {
                pipe_output(stdout, "stdout", on_output.clone());
            }
            if let Some(stderr) = child.stderr.take() {
                pipe_output(stderr, "stderr", on_output);
            }
        }

        let started_at = Instant::now();
        loop {
            if self.stop_generation.load(Ordering::SeqCst) != generation {
                terminate_child(&mut child);
                self.reap_child();
                return Err("Gateway start cancelled".into());
            }
            if let Ok(Some(_status)) = child.try_wait() {
                // 网关提前退出
                let _ = self.stop().await;
                return Err("Gateway exited during startup".into());
            }
            if self.is_healthy() {
                let mut slot = self.child.lock().unwrap();
                if self.stop_generation.load(Ordering::SeqCst) != generation {
                    terminate_child(&mut child);
                    self.owned.store(false, Ordering::Relaxed);
                    self.authenticated.store(false, Ordering::SeqCst);
                    return Err("Gateway start cancelled".into());
                }
                *slot = Some(child);
                *self.authenticated_port.lock().unwrap() = Some(port);
                return Ok(self.base_url());
            }
            if started_at.elapsed() > Duration::from_millis(self.wait_ms) {
                terminate_child(&mut child);
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
            terminate_child(&mut child);
        }
    }

    pub async fn stop(&self) { self.stop_sync(); }

    /// 同步停止自有网关（应用退出路径使用，等价于 stop() 但非 async）。
    /// 实测 app.exit(0) 不触发 managed state 的 Drop（2026-08-15），
    /// 退出清理必须由调用方在 ExitRequested 放行前显式执行。
    pub fn stop_sync(&self) {
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        self.reap_child();
    }

    /// 健康检查失败/退出时的重启入口：指数退避由调用方（main）调度
    #[allow(dead_code)]
    pub fn was_owned(&self) -> bool {
        self.owned.load(Ordering::Relaxed)
    }
}

/// 应用退出（含托盘 quit → app.exit）时清理自己拥有的网关子进程。
/// 之前缺失该清理：sidecar node 成为孤儿进程继续占用端口（2026-08-15 实机复现）。
/// attach 模式（owned=false）不触碰外部网关。kill 后 wait 回收句柄。
impl Drop for GatewaySupervisor {
    fn drop(&mut self) {
        if self.owned.load(Ordering::Relaxed) {
            if let Some(mut child) = self.child.lock().unwrap().take() {
                terminate_child(&mut child);
            }
        }
    }
}

fn terminate_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) { return; }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_parsing() {
        // 直接单元测解析逻辑（不依赖网络）
        let health = serde_json::json!({
            "ok": true, "app": "ai-cg-studio", "desktopProtocol": 1
        });
        let value: serde_json::Value = health;
        let obj = value.as_object().unwrap();
        let parsed = GatewayHealth {
            ok: obj.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            app: obj.get("app").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            desktop_protocol: obj.get("desktopProtocol").and_then(|v| v.as_i64()).unwrap_or(0),
            desktop_proof: String::new(),
        };
        assert!(is_desktop_gateway_compatible(&parsed));
    }

    #[test]
    fn port_availability_is_false_for_bound_port() {
        // 本机 127.0.0.1 上开一个监听端口，然后验证 is_port_available 为 false
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!is_port_available("127.0.0.1", port));
        assert!(is_port_available("127.0.0.1", 0)); // 0 端口必然不可连
    }

    #[test]
    fn health_reader_rejects_an_oversized_response() {
        use std::io::Write;
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 256];
            let _ = stream.read(&mut request);
            let body = vec![b'x'; MAX_HEALTH_RESPONSE_BYTES + 1];
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).unwrap();
            stream.write_all(&body).unwrap();
        });
        assert!(read_gateway_health(&format!("http://127.0.0.1:{port}"), Duration::from_millis(500)).is_none());
        handle.join().unwrap();
    }
}

#[cfg(test)]
#[path = "gateway_native_tests.rs"]
mod native_tests;
