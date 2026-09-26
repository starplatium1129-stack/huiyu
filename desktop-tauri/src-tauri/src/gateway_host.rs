use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ring::{digest, hmac};

pub fn profile_id(profile_root: &std::path::Path) -> Result<String, String> {
    std::fs::create_dir_all(profile_root).map_err(|_| "PROFILE_UNAVAILABLE")?;
    let file = profile_root.join(".huiyu-source-profile");
    if std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.file_type().is_symlink()) { return Err("PROFILE_IDENTITY".into()); }
    match std::fs::OpenOptions::new().create_new(true).write(true).open(&file) {
        Ok(mut handle) => {
            let value = format!("profile-{}", super::identity::random_secret()?);
            handle.write_all(value.as_bytes()).map_err(|_| "PROFILE_IDENTITY")?;
            handle.sync_all().map_err(|_| "PROFILE_IDENTITY")?;
            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let value = std::fs::read_to_string(file).map_err(|_| "PROFILE_IDENTITY")?;
            if value.strip_prefix("profile-").is_some_and(super::identity::valid_secret) { Ok(value) } else { Err("PROFILE_IDENTITY".into()) }
        }
        Err(_) => Err("PROFILE_UNAVAILABLE".into()),
    }
}
pub fn epoch(secret: &str) -> String {
    let hash = digest::digest(&digest::SHA256, format!("aics-runtime-epoch:v1:{secret}").as_bytes());
    hash.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn request(base: &str, secret: &str, mut payload: serde_json::Value) -> Result<serde_json::Value, String> {
    payload["timestamp"] = serde_json::json!(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "HOST_CLOCK")?.as_millis() as u64);
    payload["nonce"] = serde_json::json!(super::identity::random_secret()?);
    let body = serde_json::to_string(&payload).map_err(|_| "HOST_REQUEST")?;
    let signed = format!("aics-desktop-host:v1\n{body}");
    let signature = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()), signed.as_bytes());
    let proof: String = signature.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    let host = base.strip_prefix("http://127.0.0.1:").ok_or("HOST_ORIGIN")?;
    let address = format!("127.0.0.1:{host}").to_socket_addrs().map_err(|_| "HOST_ADDRESS")?.next().ok_or("HOST_ADDRESS")?;
    let timeout = if payload["action"] == "activate" { Duration::from_secs(120) } else { Duration::from_secs(3) };
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| "HOST_UNAVAILABLE")?;
    stream.set_read_timeout(Some(timeout)).map_err(|_| "HOST_TIMEOUT")?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|_| "HOST_TIMEOUT")?;
    let request = format!("POST /api/desktop-host HTTP/1.1\r\nHost: 127.0.0.1:{host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-AICS-Host-Proof: {proof}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream.write_all(request.as_bytes()).map_err(|_| "HOST_WRITE")?;
    let mut bytes = Vec::new();
    stream.take(32 * 1024).read_to_end(&mut bytes).map_err(|_| "HOST_READ")?;
    let response = String::from_utf8(bytes).map_err(|_| "HOST_RESPONSE")?;
    let (header, body) = response.split_once("\r\n\r\n").ok_or("HOST_RESPONSE")?;
    if !header.starts_with("HTTP/1.1 200 ") { return Err("HOST_REFUSED".into()); }
    serde_json::from_str(body).map_err(|_| "HOST_RESPONSE".into())
}

pub struct OwnerSnapshot { file: std::path::PathBuf, bytes: Vec<u8> }
pub fn owner_snapshot(config_root: &std::path::Path, pid: u32) -> Option<OwnerSnapshot> {
    let pointer = ["workspace-active.json", "workspace-candidate.json"].iter()
        .find_map(|name| std::fs::read(config_root.join(name)).ok())?;
    let pointer: serde_json::Value = serde_json::from_slice(&pointer).ok()?;
    let id = pointer["workspaceId"].as_str()?;
    if id.len() != 36 || !id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') { return None; }
    let directory = config_root.join("workspaces").join(id);
    for path in [config_root.to_path_buf(), config_root.join("workspaces"), directory.clone()] {
        if std::fs::symlink_metadata(path).ok()?.file_type().is_symlink() { return None; }
    }
    let file = directory.join(".workspace-owner.json");
    if std::fs::symlink_metadata(&file).ok()?.file_type().is_symlink() { return None; }
    let bytes = std::fs::read(&file).ok()?;
    let owner: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if owner["workspaceId"] != id || owner["pid"].as_u64()? != u64::from(pid)
        || owner["nonce"].as_str()?.is_empty() || !owner["startedAt"].is_number() { return None; }
    Some(OwnerSnapshot { file, bytes })
}
pub fn release_exited_owner(snapshot: Option<OwnerSnapshot>, child: &mut std::process::Child) {
    // A retained OS child handle, not a PID probe or a heartbeat timeout, proves
    // this exact managed owner exited. Unknown locks remain for explicit repair.
    if !matches!(child.try_wait(), Ok(Some(_))) { return; }
    let Some(snapshot) = snapshot else { return; };
    if std::fs::read(&snapshot.file).ok().as_ref() == Some(&snapshot.bytes) {
        let _ = std::fs::remove_file(snapshot.file);
    }
}
