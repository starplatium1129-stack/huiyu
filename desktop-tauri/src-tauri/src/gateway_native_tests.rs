use super::*;

fn fixture() -> (std::path::PathBuf, std::path::PathBuf, u16) {
    let root = std::env::temp_dir().join(format!("aics-gateway-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&root).unwrap();
    let script = root.join("server.cjs");
    std::fs::write(&script, r#"
const fs = require('fs');
const descendant = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
fs.writeFileSync('descendant-' + process.pid, String(descendant.pid));
require('http').createServer((req, res) => {
  let unhealthy = false;
  try { const value = fs.readFileSync('unhealthy', 'utf8'); unhealthy = value === 'all' || value === String(process.pid); } catch {}
  res.setHeader('Connection', 'close');
  const challenge = req.headers['x-aics-desktop-challenge'];
  const desktopProof = challenge && process.env.AICS_DESKTOP_GATEWAY_TOKEN ? require('crypto').createHmac('sha256', process.env.AICS_DESKTOP_GATEWAY_TOKEN).update(challenge).digest('hex') : undefined;
  res.end(JSON.stringify({ ok: !unhealthy, app: 'ai-cg-studio', desktopProtocol: 1, desktopProof }));
}).listen(Number(process.env.PORT), '127.0.0.1');
"#).unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    (root, script, listener.local_addr().unwrap().port())
}

#[test]
fn owned_unhealthy_process_is_reaped_before_restart_and_stop() {
    let (root, script, port) = fixture();
    let supervisor = GatewaySupervisorBuilder::new(script, root.clone()).port(port).wait_ms(4000).build();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        supervisor.start().await.unwrap();
        let old_pid = supervisor.child.lock().unwrap().as_ref().unwrap().id();
        let old_token = supervisor.identity_token.lock().unwrap().clone();
        let descendant_pid = std::fs::read_to_string(root.join(format!("descendant-{old_pid}"))).unwrap();
        std::fs::write(root.join("unhealthy"), old_pid.to_string()).unwrap();
        assert!(!supervisor.is_healthy());
        supervisor.start().await.unwrap();
        let new_pid = supervisor.child.lock().unwrap().as_ref().unwrap().id();
        assert_ne!(old_pid, new_pid);
        assert_ne!(old_token, supervisor.identity_token.lock().unwrap().clone());
        assert_eq!(supervisor.port(), port);
        let dead = Command::new("node").args(["-e", &format!("try {{ process.kill({old_pid}, 0); process.exit(1) }} catch {{ process.exit(0) }}")]).status().unwrap();
        assert!(dead.success(), "old owned PID survived restart");
        #[cfg(windows)]
        assert!(Command::new("node").args(["-e", &format!("try {{ process.kill({descendant_pid}, 0); process.exit(1) }} catch {{ process.exit(0) }}")]).status().unwrap().success(), "old descendant survived restart");
        supervisor.stop().await;
        assert!(is_port_available(GATEWAY_HOST, port));
        assert!(!supervisor.owns_gateway());
        let occupied = std::net::TcpListener::bind((GATEWAY_HOST, port)).unwrap();
        assert!(supervisor.start().await.unwrap_err().contains("restart the desktop"));
        assert_eq!(supervisor.port(), port);
        drop(occupied);
    });
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn attached_external_process_survives_stop() {
    let (root, script, port) = fixture();
    let mut command = Command::new("node");
    command.arg(&script).current_dir(&root).env("PORT", port.to_string()).env("AICS_DESKTOP_GATEWAY_TOKEN", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut external = command.spawn().unwrap();
    let supervisor = GatewaySupervisorBuilder::new(script, root.clone()).port(port).build();
    *supervisor.identity_token.lock().unwrap() = Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into());
    let deadline = Instant::now() + Duration::from_secs(4);
    while !supervisor.is_healthy() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        supervisor.start().await.unwrap();
        assert!(!supervisor.owns_gateway());
        supervisor.stop().await;
        assert!(external.try_wait().unwrap().is_none());
        assert!(supervisor.is_healthy());
    });
    terminate_child(&mut external);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn forged_public_health_cannot_attach_and_falls_back_to_an_owned_port() {
    let (root, script, port) = fixture();
    let mut command = Command::new("node");
    command.arg(&script).current_dir(&root).env("PORT", port.to_string())
        .env("AICS_DESKTOP_GATEWAY_TOKEN", "attacker-controlled-secret")
        .stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut external = command.spawn().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(4);
    while read_gateway_health(&base, Duration::from_millis(200)).is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let supervisor = GatewaySupervisorBuilder::new(script, root.clone()).port(port).wait_ms(4000).build();
    *supervisor.identity_token.lock().unwrap() = None;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        assert!(!supervisor.is_healthy());
        *supervisor.identity_token.lock().unwrap() = Some("f".repeat(64));
        assert!(!supervisor.is_healthy(), "a forged proof must not authenticate");
        supervisor.start().await.unwrap();
        assert!(supervisor.owns_gateway());
        assert_ne!(supervisor.port(), port);
        assert!(supervisor.is_healthy());
        assert!(external.try_wait().unwrap().is_none());
        supervisor.stop().await;
    });
    terminate_child(&mut external);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn trickling_health_response_cannot_extend_total_deadline() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let writer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 512];
        let _ = stream.read(&mut request);
        for byte in b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}" {
            if stream.write_all(&[*byte]).is_err() { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let started = Instant::now();
    assert!(read_gateway_health(&format!("http://127.0.0.1:{port}"), Duration::from_millis(100)).is_none());
    assert!(started.elapsed() < Duration::from_millis(500));
    writer.join().unwrap();
}
#[test]
fn stop_during_startup_cannot_publish_a_late_child() {
    let (root, script, port) = fixture();
    std::fs::write(root.join("unhealthy"), "all").unwrap();
    let supervisor = Arc::new(GatewaySupervisorBuilder::new(script, root.clone()).port(port).wait_ms(4000).build());
    let starting = supervisor.clone();
    let worker = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(starting.start())
    });
    let deadline = Instant::now() + Duration::from_secs(4);
    while !std::fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with("descendant-")) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    supervisor.stop_sync();
    assert!(worker.join().unwrap().unwrap_err().contains("cancelled"));
    assert!(supervisor.child.lock().unwrap().is_none());
    assert!(!supervisor.is_authenticated());
    assert!(!supervisor.owns_gateway());
    assert!(is_port_available(GATEWAY_HOST, port));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn malformed_attach_secret_is_rejected_before_launch() {
    let (root, script, port) = fixture();
    let supervisor = GatewaySupervisorBuilder::new(script, root.clone()).port(port).build();
    *supervisor.identity_token.lock().unwrap() = Some("invalid".into());
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    assert!(runtime.block_on(supervisor.start()).unwrap_err().contains("64 lowercase"));
    assert!(!supervisor.owns_gateway());
    assert!(supervisor.child.lock().unwrap().is_none());
    std::fs::remove_dir_all(root).unwrap();
}
