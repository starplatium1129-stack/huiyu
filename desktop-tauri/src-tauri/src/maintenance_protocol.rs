//! Fixed local deployment requests. No renderer supplies a path or host secret.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const CLI_FLAG: &str = "--desktop-maintenance";
pub const CAPABILITY_FILE: &str = "desktop-maintenance.json";
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub protocol_version: u32,
    pub instance_id: String,
    pub host_pid: u32,
    pub started_at_filetime: String,
    pub executable: String,
    pub instance_namespace: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub instance_id: String,
    pub host_pid: u32,
    pub command: String,
}
pub fn valid_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn valid_namespace(value: &str) -> bool {
    value == "com.aics.studio" || value.strip_prefix("com.aics.studio.maintenance.")
        .is_some_and(|suffix| suffix.len() == 64 && suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
pub fn cli_namespace(argv: &[String]) -> Result<String, String> {
    let index = argv.iter().position(|value| value == "--maintenance-namespace").ok_or("MAINTENANCE_NAMESPACE")?;
    argv.get(index + 1).filter(|value| valid_namespace(value)).cloned().ok_or_else(|| "MAINTENANCE_NAMESPACE".into())
}
pub fn cli(argv: &[String]) -> Option<Result<(String, String), String>> {
    let at = argv.iter().position(|value| value == CLI_FLAG)?;
    Some((|| {
        let command = argv.get(at + 1).filter(|v| matches!(v.as_str(), "status" | "shutdown")).ok_or("MAINTENANCE_COMMAND")?;
        let index = argv.iter().position(|value| value == "--maintenance-request").ok_or("MAINTENANCE_REQUEST")?;
        let request_id = argv.get(index + 1).filter(|value| valid_id(value)).ok_or("MAINTENANCE_REQUEST")?;
        Ok((command.clone(), request_id.clone()))
    })())
}
pub fn directory(root: &Path) -> Result<PathBuf, String> {
    let target = root.join("desktop-maintenance");
    std::fs::create_dir_all(&target).map_err(|_| "MAINTENANCE_DIRECTORY")?;
    if std::fs::symlink_metadata(&target).map_err(|_| "MAINTENANCE_DIRECTORY")?.file_type().is_symlink() { return Err("MAINTENANCE_DIRECTORY".into()); }
    Ok(target)
}
pub fn load_request(root: &Path, identity: &Identity, command: &str, id: &str) -> Result<Request, String> {
    if !valid_id(id) { return Err("MAINTENANCE_REQUEST".into()); }
    let file = directory(root)?.join(format!("{id}.request.json"));
    let metadata = std::fs::symlink_metadata(&file).map_err(|_| "MAINTENANCE_REQUEST")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 { return Err("MAINTENANCE_REQUEST".into()); }
    let request: Request = serde_json::from_slice(&std::fs::read(file).map_err(|_| "MAINTENANCE_REQUEST")?).map_err(|_| "MAINTENANCE_REQUEST")?;
    if request.request_id != id || request.command != command || request.instance_id != identity.instance_id || request.host_pid != identity.host_pid {
        return Err("MAINTENANCE_IDENTITY_CHANGED".into());
    }
    Ok(request)
}
pub fn write_json(file: &Path, value: &impl Serialize) -> Result<(), String> {
    use std::io::Write;
    let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
    let mut writer = std::fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|_| "MAINTENANCE_RECEIPT")?;
    writer.write_all(serde_json::to_string(value).map_err(|_| "MAINTENANCE_RECEIPT")?.as_bytes()).map_err(|_| "MAINTENANCE_RECEIPT")?;
    writer.sync_all().map_err(|_| "MAINTENANCE_RECEIPT")?;
    drop(writer);
    std::fs::rename(temporary, file).map_err(|_| "MAINTENANCE_RECEIPT".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maintenance_cli_is_finite_and_never_accepts_paths() {
        let args = |command: &str, id: &str| vec!["app.exe".into(), CLI_FLAG.into(), command.into(), "--maintenance-request".into(), id.into()];
        assert!(cli(&args("status", &"a".repeat(32))).unwrap().is_ok());
        assert!(cli(&args("shutdown", "../outside")).unwrap().is_err());
        assert!(cli(&args("exec", &"a".repeat(32))).unwrap().is_err());
        assert!(cli(&["app.exe".into(), "aics://chat".into()]).is_none());
    }
    #[test]
    fn requests_bind_instance_and_actual_host_pid() {
        let root = std::env::temp_dir().join(format!("huiyu-maintenance-{}", std::process::id()));
        let identity = Identity { protocol_version:1, instance_id:"instance".into(), host_pid:42, started_at_filetime:"birth".into(), executable:"app".into(), instance_namespace:"com.aics.studio".into() };
        let id = "a".repeat(32); let file = directory(&root).unwrap().join(format!("{id}.request.json"));
        std::fs::write(&file, serde_json::to_vec(&Request { request_id:id.clone(), instance_id:"instance".into(), host_pid:43, command:"shutdown".into() }).unwrap()).unwrap();
        assert!(load_request(&root, &identity, "shutdown", &id).is_err());
        std::fs::write(&file, serde_json::to_vec(&Request { request_id:id.clone(), instance_id:"instance".into(), host_pid:42, command:"shutdown".into() }).unwrap()).unwrap();
        assert!(load_request(&root, &identity, "shutdown", &id).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
}
