use super::{Error, Result, paths, text};
use crate::processes::Processes;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

const ALLOWED: &[&str] = &[
    "python",
    "python3",
    "pythonw",
    "pwsh",
    "powershell",
    "node",
    "npm",
    "npx",
    "git",
    "conda",
];
pub(super) async fn resolve(
    root: &Path,
    raw: &str,
    args: Vec<String>,
) -> Result<(PathBuf, Vec<String>)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(Error::plain("缺少命令"));
    }
    let command = if raw.contains(['/', '\\']) {
        paths::resolve(root, raw).await?
    } else {
        let mut name = raw.to_lowercase();
        if name.ends_with(".exe") {
            name.truncate(name.len() - 4);
        }
        if matches!(name.as_str(), "npm.cmd" | "npx.cmd") {
            name.truncate(name.len() - 4);
        }
        if !ALLOWED.contains(&name.as_str()) {
            return Err(Error::plain(
                "命令不在允许列表（python/pwsh/node/npm/npx/git/conda）或缺少工作区内脚本相对路径",
            ));
        }
        PathBuf::from(raw)
    };
    #[cfg(windows)]
    {
        let lower = raw.to_lowercase();
        let name = lower
            .strip_suffix(".exe")
            .or_else(|| lower.strip_suffix(".cmd"))
            .unwrap_or(&lower);
        if matches!(name, "npm" | "npx") {
            // Rust's process executable is not Node. Resolve the installed Node
            // beside its npm CLI and invoke that .js directly without cmd.exe.
            let path = std::env::var_os("PATH").unwrap_or_default();
            let directories = std::env::split_paths(&path)
                .filter(|path| path.is_absolute())
                .collect::<Vec<_>>();
            let node = directories
                .iter()
                .map(|directory| directory.join("node.exe"))
                .find(|file| file.is_file());
            if let Some(node) = node {
                for directory in std::iter::once(node.parent().unwrap())
                    .chain(directories.iter().map(PathBuf::as_path))
                {
                    let cli = directory.join(format!("node_modules/npm/bin/{name}-cli.js"));
                    if cli.is_file() {
                        let mut resolved =
                            vec![paths::display(&tokio::fs::canonicalize(cli).await?)];
                        resolved.extend(args);
                        return Ok((node, resolved));
                    }
                }
            }
            return Err(Error::coded(
                "TOOL_UNAVAILABLE",
                format!("当前 Node 安装中未找到 {name} 的 CLI，请检查 Node/npm 安装"),
            ));
        }
    }
    #[cfg(windows)]
    if command
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["bat", "cmd"]
                .iter()
                .any(|blocked| extension.eq_ignore_ascii_case(blocked))
        })
    {
        // std::process can invoke cmd.exe implicitly for batch files; Node's
        // shell:false path did not. Keep shell syntax out of this tool contract.
        return Err(Error::coded(
            "TOOL_UNAVAILABLE",
            "不通过 shell 执行批处理；请直接选择对应解释器与参数数组",
        ));
    }
    Ok((command, args))
}
pub(super) async fn run(
    root: &Path,
    input: &Value,
    trusted: bool,
    pool: &Arc<Processes>,
    cancel: &CancellationToken,
) -> Result<Value> {
    if !trusted {
        return Err(Error::coded(
            "TRUSTED_EXECUTION_REQUIRED",
            "通用命令默认关闭：此能力可访问当前系统账户的文件，并非仅限工作区。仅操作员可通过 AICS_DESKTOP_COMMANDS=trusted 启用后重启网关",
        ));
    }
    let raw = text(&input["command"]);
    let args = input["args"]
        .as_array()
        .map(|args| args.iter().map(string_argument).collect::<Vec<_>>())
        .unwrap_or_default();
    if raw.encode_utf16().count() > 256 {
        return Err(Error::plain("命令名过长"));
    }
    if args.len() > 16 {
        return Err(Error::plain("参数过多"));
    }
    if args.iter().any(|arg| arg.encode_utf16().count() > 256) {
        return Err(Error::plain("参数过长"));
    }
    let (command, args) = resolve(root, &raw, args).await?;
    let (stdout, stderr) = execute(
        pool,
        &command,
        &args,
        Some(root),
        Duration::from_secs(120),
        64 * 1024,
        cancel,
    )
    .await?;
    let output = format!("{stdout}{stderr}");
    let output = output.trim();
    Ok(json!({"ok":true,"output":if output.is_empty(){"（命令已执行，无输出）"}else{output}}))
}
fn string_argument(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(false) => "false".into(),
        Value::Number(n) if n.as_f64() == Some(0.0) => "0".into(),
        _ => text(value),
    }
}

async fn collect<T: AsyncRead + Unpin>(
    stream: Option<T>,
    count: Arc<AtomicUsize>,
    limit: usize,
) -> Result<Vec<u8>> {
    let Some(mut stream) = stream else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let length = stream.read(&mut chunk).await?;
        if length == 0 {
            break;
        }
        if count
            .fetch_add(length, Ordering::Relaxed)
            .saturating_add(length)
            > limit
        {
            return Err(Error::coded(
                "COMMAND_OUTPUT_LIMIT",
                "命令输出超过上限，已停止执行",
            ));
        }
        output.extend_from_slice(&chunk[..length]);
    }
    Ok(output)
}
pub(super) async fn execute(
    pool: &Arc<Processes>,
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<(String, String)> {
    if cancel.is_cancelled() {
        return Err(Error::cancelled());
    }
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let child = pool.spawn(&mut command).map_err(Error::from)?;
    let (stdout, stderr) = child.take_output();
    let count = Arc::new(AtomicUsize::new(0));
    let work = async {
        let wait = async {
            loop {
                if let Some(status) = child.exit_status().map_err(Error::from)? {
                    return Ok::<_, Error>(status);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        let (stdout, stderr, status) = tokio::try_join!(
            collect(stdout, count.clone(), limit),
            collect(stderr, count, limit),
            wait
        )?;
        let stdout = String::from_utf8_lossy(&stdout).into_owned();
        let stderr = String::from_utf8_lossy(&stderr).into_owned();
        if !status.success() {
            let detail = super::files::truncate(
                if stderr.is_empty() {
                    stdout.trim()
                } else {
                    stderr.trim()
                },
                1500,
            );
            return Err(Error::coded(
                "COMMAND_FAILED",
                format!(
                    "命令执行失败（{}）{}",
                    status
                        .code()
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "signal".into()),
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!("：{detail}")
                    }
                ),
            ));
        }
        Ok((stdout, stderr))
    };
    let result = tokio::select! {result=work=>result,_=cancel.cancelled()=>Err(Error::cancelled()),_=tokio::time::sleep(timeout)=>Err(Error::coded("COMMAND_TIMEOUT","命令执行超时，已停止执行"))};
    // Explicit cancellation paths confirm the owned process has exited before
    // returning; dropped HTTP futures use the same pool's tracked cleanup.
    if let Err(error) = child.stop().await {
        return Err(error.into());
    }
    result
}

pub(super) async fn screen(pool: &Arc<Processes>, cancel: &CancellationToken) -> Result<Value> {
    if !cfg!(windows) {
        return Err(Error::plain("当前系统暂不支持原生屏幕截取"));
    }
    let script = include_str!("capture-screen.ps1").to_owned();
    let args = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-Command".into(),
        script,
    ];
    let (stdout, _) = execute(
        pool,
        Path::new("powershell"),
        &args,
        None,
        Duration::from_secs(10),
        20 * 1024 * 1024,
        cancel,
    )
    .await?;
    let base64 = stdout.trim();
    if base64.is_empty() {
        return Err(Error::plain("未捕获到屏幕数据"));
    }
    Ok(
        json!({"ok":true,"output":format!("已成功捕获当前桌面屏幕画面（{} KB JPEG）",(base64.len() as f64*0.75/1024.0).round() as u64),"imageDataUrl":format!("data:image/jpeg;base64,{base64}")}),
    )
}
