mod config;
mod delta;
mod download;
mod fs;
mod group_reads;
mod http;
mod lease;
mod lifecycle;
mod manager;
mod manifest;
pub mod offline;
mod policy;
mod resolve;
mod state;
#[cfg(test)]
mod tests;
pub use http::{overlay, router};
pub use manager::Service;

pub(crate) fn check_available_space(path: &std::path::Path, needed: u64) -> Result<()> {
    fs::space(path, needed)
}

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug)]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::new(
            match error.raw_os_error() {
                Some(2 | 3) => "ENOENT",
                Some(28 | 112) => "ENOSPC",
                _ if error.kind() == std::io::ErrorKind::NotFound => "ENOENT",
                _ => "RESOURCE_IO",
            },
            error.to_string(),
        )
    }
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}
fn equal(left: &Value, right: &Value) -> bool {
    crate::storage::stringify(left) == crate::storage::stringify(right)
}
fn number(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && *number >= 0.0
                && number.fract() == 0.0
                && *number <= 9_007_199_254_740_991.0
        })
        .map(|number| number as u64)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Error::new("RESOURCE_FAILED", "Resource worker stopped"))?
}
fn public(error: &Error) -> Value {
    let code = if error.code.len() <= 51
        && error
            .code
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_uppercase)
        && error
            .code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        error.code.as_str()
    } else {
        "RESOURCE_FAILED"
    };
    let message = match code {
        "CONFIG_REQUIRED" => "尚未配置可信的本地资源库。",
        "CONFIG_CHANGED" => "资源配置已变化，请重新检查后操作。",
        "PROTECTED_ROOT" => "资源目录与程序或作品目录重叠，请调整本地配置。",
        "ACCESS_DENIED" => "本机授权已失效，操作已停止。",
        "APPROVAL_REQUIRED" => "该资源版本尚未获得独立审批。",
        "SOURCE_REQUIRED" => "资源来源未配置或未经批准。",
        "UNSAFE_SOURCE" => "资源来源不符合安全要求。",
        "RESOURCE_BUSY" => "资源读取繁忙，请稍后重试。",
        "BUSY" => "另一个资源操作正在执行，或中断操作需要恢复。",
        "PENDING_TRANSACTION" => "上次资源操作尚未完成，请恢复后再安装其他版本。",
        "CANCELLED" => "操作已取消，已验证资源与可续传内容已保留。",
        "ENOSPC" => "磁盘空间不足，原有资源仍被保留。",
        "ENOENT" => "资源文件缺失，请检查离线介质或先下载所选资源。",
        "CONTENT_INVALID" => "资源内容校验失败，正在使用随包基础资源。",
        "INSTALLED_TAMPERED" => "已安装资源被修改，已停止使用该资源版本。",
        "BASELINE_MISMATCH" => "增量包与当前安装版本不兼容。",
        "NO_PREVIOUS_VERSION" => "没有可回退的旧版本。",
        "INTERRUPTED" => "操作因网关重启中断，可继续恢复。",
        "MANAGEMENT_DISABLED" => "本机资源管理尚未启用，基础展示仍可使用。",
        _ => "资源操作未通过检查，请核对本地配置与资源包。",
    };
    json!({"code":code,"message":message})
}
