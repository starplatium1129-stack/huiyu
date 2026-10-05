use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use ring::{digest, hmac};

fn read_profile(file: &std::path::Path) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(file).map_err(|_| "PROFILE_IDENTITY")?;
    if metadata.file_type().is_symlink() { return Err("PROFILE_IDENTITY".into()); }
    let value = std::fs::read_to_string(file).map_err(|_| "PROFILE_IDENTITY")?;
    if value.strip_prefix("profile-").is_some_and(super::identity::valid_secret) { Ok(value) } else { Err("PROFILE_IDENTITY".into()) }
}

pub fn profile_id(profile_root: &std::path::Path) -> Result<String, String> {
    std::fs::create_dir_all(profile_root).map_err(|_| "PROFILE_UNAVAILABLE")?;
    let file = profile_root.join(".huiyu-source-profile");
    match std::fs::symlink_metadata(&file) {
        Ok(_) => return read_profile(&file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err("PROFILE_UNAVAILABLE".into()),
    }
    // Same-directory publication retains Windows extended-length paths. A
    // readable existing identity never needs creation/deletion permissions.
    let root = std::fs::canonicalize(profile_root).map_err(|_| "PROFILE_UNAVAILABLE")?;
    let file = root.join(".huiyu-source-profile");
    let value = format!("profile-{}", super::identity::random_secret()?);
    let temporary = root.join(format!(".huiyu-source-profile.{}.pending", &value[8..]));
    let mut handle = std::fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|_| "PROFILE_UNAVAILABLE")?;
    let written = handle.write_all(value.as_bytes()).and_then(|()| handle.sync_all());
    drop(handle);
    let published = written.and_then(|()| publish_profile(&temporary, &file));
    // Only our create_new temporary is removed, never an existing identity.
    let _ = std::fs::remove_file(&temporary);
    match published {
        Ok(()) => Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_profile(&file),
        Err(_) => Err("PROFILE_IDENTITY".into()),
    }
}
#[cfg(not(windows))]
fn publish_profile(temporary: &std::path::Path, file: &std::path::Path) -> std::io::Result<()> {
    std::fs::hard_link(temporary, file)?;
    std::fs::File::open(file.parent().unwrap())?.sync_all()
}
#[cfg(windows)]
fn publish_profile(temporary: &std::path::Path, file: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let wide = |path: &std::path::Path| -> std::io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) { return Err(std::io::ErrorKind::InvalidInput.into()); }
        value.push(0); Ok(value)
    };
    let (source, target) = (wide(temporary)?, wide(file)?);
    // No REPLACE_EXISTING or COPY_ALLOWED: never overwrite a racing publisher
    // or silently turn same-directory publication into a cross-volume copy.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0 { return Ok(()); }
    let error = std::io::Error::last_os_error();
    if matches!(error.raw_os_error(), Some(80 | 183)) { Err(std::io::ErrorKind::AlreadyExists.into()) } else { Err(error) }
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
    let timeout = match payload["action"].as_str() {
        Some("prepare-candidate") => Duration::from_secs(225),
        Some("activate" | "enable-bundled") => Duration::from_secs(420),
        Some("shutdown") => Duration::from_secs(30),
        _ => Duration::from_secs(3),
    };
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| "HOST_UNAVAILABLE")?;
    stream.set_read_timeout(Some(timeout)).map_err(|_| "HOST_TIMEOUT")?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|_| "HOST_TIMEOUT")?;
    let request = format!("POST /api/desktop-host HTTP/1.1\r\nHost: 127.0.0.1:{host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-AICS-Host-Proof: {proof}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream.write_all(request.as_bytes()).map_err(|_| "HOST_WRITE")?;
    let mut bytes = Vec::new();
    let deadline = Instant::now() + timeout;
    let mut buffer = [0; 4096];
    while bytes.len() < 32 * 1024 {
        let remaining = deadline.checked_duration_since(Instant::now()).filter(|time| !time.is_zero()).ok_or("HOST_READ")?;
        stream.set_read_timeout(Some(remaining)).map_err(|_| "HOST_TIMEOUT")?;
        let capacity = buffer.len().min(32 * 1024 - bytes.len());
        let read = stream.read(&mut buffer[..capacity]).map_err(|_| "HOST_READ")?;
        if read == 0 { break; }
        bytes.extend_from_slice(&buffer[..read]);
    }
    let response = String::from_utf8(bytes).map_err(|_| "HOST_RESPONSE")?;
    let (header, body) = response.split_once("\r\n\r\n").ok_or("HOST_RESPONSE")?;
    if !header.starts_with("HTTP/1.1 200 ") {
        if payload["action"] == "prepare-candidate" {
            if let Ok(error) = serde_json::from_str::<serde_json::Value>(body) {
                if let (Some(code), Some(message)) = (error["code"].as_str(), error["error"].as_str()) {
                    return Err(format!("{code}: {message}"));
                }
            }
        }
        return Err("HOST_REFUSED".into());
    }
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
