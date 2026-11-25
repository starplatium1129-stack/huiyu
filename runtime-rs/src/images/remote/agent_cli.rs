use crate::{
    AppState,
    error::{ApiError, Result},
};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command, sync::Semaphore};

static WORKERS: Semaphore = Semaphore::const_new(4);

/// Node's main-module resolution on Windows fails with EISDIR on `\\?\` verbatim paths
/// produced by `Path::canonicalize()`. Strip the verbatim prefix before invoking Node.
fn node_path(path: &Path) -> Cow<'_, Path> {
    #[cfg(windows)]
    if let Some(raw) = path.to_str() {
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return Cow::Owned(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(drive) = raw.strip_prefix(r"\\?\") {
            return Cow::Borrowed(Path::new(drive));
        }
    }
    Cow::Borrowed(path)
}

/// The desktop, QQ and external agents use the same CLI command dispatcher.
/// Only the host chooses the executable, local listener, credentials and export directory.
pub(crate) async fn invoke(
    app: &AppState,
    input: &Value,
    agent: &str,
    scoped: bool,
) -> Result<Value> {
    app.host.check_running()?;
    let images = app.images.as_ref().ok_or_else(super::super::closed)?;
    let (port, token) = images
        .agent_cli_endpoint
        .get()
        .filter(|_| super::listening())
        .ok_or_else(|| {
            ApiError::new(
                503,
                "DRAWING_LISTENER_OFFLINE",
                "请开启「允许其他绘遇连接本机绘图」，保存后重启桌面端",
            )
        })?;
    let _slot = WORKERS
        .try_acquire()
        .map_err(|_| ApiError::new(429, "DRAWING_CLI_BUSY", "共享绘图工具正忙，请稍后再查"))?;
    let payload = serde_json::to_vec(input)?;
    if payload.len() > 256 * 1024 {
        return Err(ApiError::invalid("绘图工具请求过大"));
    }
    let node_raw = if app.config.is_packaged() {
        app.config.app_root.join("qq-sdk/node.exe")
    } else {
        PathBuf::from("node")
    };
    let script_raw = app.config.app_root.join("tools/cli-anything-huiyu/cli.mjs");
    let output_dir_raw = app.config.runtime_root.join("agent-drawings");
    let mut command = Command::new(node_path(&node_raw).as_ref());
    command.env_clear();
    for key in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .current_dir(node_path(&app.config.app_root).as_ref())
        .arg(node_path(&script_raw).as_ref())
        .args(["--json", "invoke"])
        .env("HUIYU_CLI_PORT", port.to_string())
        .env("HUIYU_CLI_TOKEN", token)
        .env("HUIYU_CLI_AGENT", agent)
        .env("HUIYU_CLI_OUTPUT_DIR", node_path(&output_dir_raw).as_ref())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if scoped {
        command.env("HUIYU_CLI_SCOPE", agent);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let unavailable = || {
        ApiError::new(
            503,
            "DRAWING_CLI_UNAVAILABLE",
            "绘图命令行不可用，请检查桌面安装目录中的 Node 和 cli-anything-huiyu",
        )
    };
    let work = async {
        let mut child = command.spawn().map_err(|error| {
            eprintln!("agent_cli spawn failed ({}): {error}", node_raw.display());
            unavailable()
        })?;
        let mut stdin = child.stdin.take().ok_or_else(unavailable)?;
        stdin.write_all(&payload).await.map_err(|error| {
            eprintln!("agent_cli stdin write failed: {error}");
            unavailable()
        })?;
        drop(stdin);
        let output = child.wait_with_output().await.map_err(|error| {
            eprintln!("agent_cli wait failed: {error}");
            unavailable()
        })?;
        let data = if output.status.success() {
            &output.stdout
        } else {
            &output.stderr
        };
        serde_json::from_slice::<Value>(data).map_err(|error| {
            let preview = String::from_utf8_lossy(data);
            eprintln!(
                "agent_cli invalid JSON (status={:?}, err={error}): {}",
                output.status.code(),
                preview.chars().take(400).collect::<String>()
            );
            unavailable()
        })
    };
    tokio::select! {
        _ = app.shutdown.cancelled() => Err(unavailable()),
        result = tokio::time::timeout(Duration::from_secs(60), work) => result.unwrap_or_else(|_| Ok(json!({
            "ok":false, "code":"DRAWING_CLI_TIMEOUT", "requestKey":input["batchKey"],
            "message":"等待绘图工具超时，请用原编号查回执后再决定是否重试。"
        }))),
    }
}
