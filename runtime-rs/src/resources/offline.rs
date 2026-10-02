//! An explicit local import. The approval anchor comes from the operator, never
//! from a flag or checksum inside the downloaded archive.
mod install;
mod paths;
mod release;
mod showcase;
#[cfg(test)]
mod tests;

use super::{Error, Result, Value, config, fs, json, lease};
use crate::config::Config;
pub(crate) use paths::showcase_root;
use std::{collections::HashMap, path::PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Options {
    package: PathBuf,
    expected: String,
    app: PathBuf,
    runtime: PathBuf,
    apply: bool,
    cancel_stdin: bool,
}
impl Options {
    fn gateway(&self) -> Config {
        Config {
            app_root: self.app.clone(),
            runtime_root: self.runtime.clone(),
            ai_workspace_root: self.runtime.join("unused-ai"),
            sd_host: "http://127.0.0.1:1".into(),
            sd_auth: None,
            comfy_host: "http://127.0.0.1:1".into(),
            bind: "127.0.0.1:0".parse().unwrap(),
            token: String::new(),
            desktop_secret: None,
            source_profile_id: None,
            workspace_pointer: None,
            workspace_candidate: None,
            config_root: None,
            gateway_origin: String::new(),
            workspace_root: None,
            workspace_id: None,
            create_workspace: false,
        }
    }
}
fn absolute(raw: Option<&String>, name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(raw.ok_or_else(|| Error::new("USAGE", format!("{name} required")))?);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(Error::new(
            "UNSAFE_PATH",
            format!("{name} must be absolute without parent traversal"),
        ));
    }
    fs::absolute(&path)
}
fn parse(args: &[String]) -> Result<Options> {
    let mut flags = HashMap::new();
    let mut apply = false;
    let mut cancel_stdin = false;
    let mut index = 1;
    while index < args.len() {
        let key = &args[index];
        if key == "--cancel-stdin" {
            if cancel_stdin {
                return Err(Error::new("USAGE", "Duplicate --cancel-stdin"));
            }
            cancel_stdin = true;
            index += 1;
            continue;
        }
        if key == "--apply" {
            if apply {
                return Err(Error::new("USAGE", "Duplicate --apply"));
            }
            apply = true;
            index += 1;
            continue;
        }
        if ![
            "--package-root",
            "--expected-release-sha256",
            "--app-root",
            "--runtime-root",
        ]
        .contains(&key.as_str())
            || index + 1 == args.len()
            || flags.insert(key.clone(), args[index + 1].clone()).is_some()
        {
            return Err(Error::new(
                "USAGE",
                "Unknown, duplicate or incomplete offline-import argument",
            ));
        }
        index += 2;
    }
    let expected = flags
        .get("--expected-release-sha256")
        .cloned()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !super::hash(&expected) {
        return Err(Error::new(
            "APPROVAL_REQUIRED",
            "A SHA256 from the trusted release page is required",
        ));
    }
    Ok(Options {
        package: absolute(flags.get("--package-root"), "--package-root")?,
        app: absolute(flags.get("--app-root"), "--app-root")?,
        runtime: absolute(flags.get("--runtime-root"), "--runtime-root")?,
        expected,
        apply,
        cancel_stdin,
    })
}

pub async fn cli(args: &[String]) -> Result<Option<Value>> {
    if args.first().map(String::as_str) != Some("offline-import") {
        return Ok(None);
    }
    if args.len() == 2 && ["--help", "-h"].contains(&args[1].as_str()) {
        return Ok(Some(
            json!({"ok":true,"usage":"huiyu-runtime offline-import --package-root <absolute extracted directory> --expected-release-sha256 <SHA256 from trusted release page> --app-root <installed gateway> --runtime-root <user gateway directory> [--apply] [--cancel-stdin]","preview":"Default: validate all files without writing. Close the desktop application before --apply. Repeat the same command to recover an interrupted import.","cancellation":"With --cancel-stdin, a byte or EOF on stdin requests cooperative cancellation."}),
        ));
    }
    let options = parse(args)?;
    let cancel = CancellationToken::new();
    if options.cancel_stdin {
        let signal = cancel.clone();
        // The graphical helper owns this pipe. A byte or EOF requests normal
        // cooperative cancellation/rollback, including when the helper closes.
        // A detached OS thread avoids async stdin blocking Tokio shutdown.
        std::thread::spawn(move || cancel_on_input(std::io::stdin(), &signal));
    }
    let signal = cancel.clone();
    let signal_task = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal.cancel();
        }
    });
    let timeout = cancel.clone();
    let timeout_task = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        timeout.cancel();
    });
    let result = super::blocking(move || execute(&options, &cancel)).await;
    signal_task.abort();
    timeout_task.abort();
    result.map(Some)
}
fn cancel_on_input(mut input: impl std::io::Read, cancel: &CancellationToken) {
    let _ = input.read(&mut [0u8; 1]);
    cancel.cancel();
}
fn execute(options: &Options, cancel: &CancellationToken) -> Result<Value> {
    let paths = paths::Paths::new(options)?;
    let release = release::load(options, cancel)?;
    let preview = install::preview(options, &paths, &release, cancel)?;
    if !options.apply {
        return Ok(preview);
    }
    let _guard = session(&options.runtime)?;
    config::cancelled(cancel)?;
    // Re-read approval and every source file after admission, before any install.
    let release = release::load(options, cancel)?;
    install::apply(options, &paths, &release, cancel)
}

pub struct RuntimeGuard {
    _lock: lease::Lock,
}
fn session(runtime: &std::path::Path) -> Result<RuntimeGuard> {
    let store = runtime.join("offline-session-v1");
    fs::ensure(&store.join("locks"))?;
    Ok(RuntimeGuard {
        _lock: lease::acquire_at(&store, "runtime", 0)?,
    })
}
/// A gateway and an importer must never own the same mutable content tree.
/// This lease only serializes local processes; it grants no HTTP authority.
pub fn gateway_guard(config: &Config) -> Result<RuntimeGuard> {
    let guard = session(&config.runtime_root)?;
    if fs::safe(
        &config.runtime_root.join("offline-install-pending.json"),
        true,
        false,
    )?
    .is_some()
    {
        return Err(Error::new(
            "PENDING_TRANSACTION",
            "离线资源导入曾中断，请完全退出桌面后使用同一资源包和官方 SHA256 重新执行导入",
        ));
    }
    Ok(guard)
}
