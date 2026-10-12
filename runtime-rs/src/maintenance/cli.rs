use super::{Error, Options, Result, fs, recovery};
use crate::file_paths;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const USAGE: &str = "huiyu-runtime maintenance-recovery --root <absolute-path> --runtime-root <absolute-path> [--showcase-root <absolute-path>] [--backup-id <id>] [--out <new-plan.json>]\nhuiyu-runtime maintenance-recovery --root <absolute-path> --runtime-root <absolute-path> [--showcase-root <absolute-path>] --apply-plan <saved-signed-plan.json>\nThe default is read-only preview. --out creates a new file and never overwrites one. Apply requires the saved, signed preview and rechecks the current journal and file identities.";
const MAX_PLAN: u64 = 32 * 1024 * 1024;

fn usage(message: impl Into<String>) -> Error {
    Error::new(400, "MAINTENANCE_USAGE", message)
}
fn root(value: Option<&String>, flag: &str) -> Result<PathBuf> {
    let value = value
        .filter(|value| !value.is_empty())
        .ok_or_else(|| usage(format!("{flag} is required")))?;
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(usage(format!("{flag} must be an absolute path")));
    }
    Ok(file_paths::absolute(path)?)
}
fn read_plan(path: &Path) -> Result<Value> {
    fs::safe(path, false, false)?;
    let file = std::fs::File::open(path)?;
    let identity = crate::file_identity::opened(&file)?;
    fs::safe(path, false, false)?;
    if identity != crate::file_identity::path(path, false)? {
        return Err(Error::conflict("恢复计划文件读取期间已变化"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_PLAN + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PLAN {
        return Err(usage("Recovery plan exceeds 32 MiB"));
    }
    serde_json::from_slice(&bytes).map_err(|_| usage("Recovery plan is not valid JSON"))
}
fn save_new(path: &Path, plan: &Value) -> Result<()> {
    // Exclusive creation protects an operator's earlier reviewed plan. No
    // output directory is created implicitly and no existing file is replaced.
    fs::safe(path, false, true)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            usage("--out must name a new file; existing plan was preserved")
        } else {
            error.into()
        }
    })?;
    let identity = crate::file_identity::opened(&file)?;
    let result = (|| -> Result<()> {
        fs::safe(path, false, false)?;
        file.write_all(
            serde_json::to_string_pretty(plan)
                .map_err(|_| usage("Recovery plan serialization failed"))?
                .as_bytes(),
        )?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if result.is_err()
        && crate::file_identity::path(path, false).is_ok_and(|current| current == identity)
    {
        let _ = std::fs::remove_file(path);
    }
    result
}

/// Pass argv after the executable name, before server config or listener setup.
/// Other commands return None; this path never initializes runtime services.
pub fn run(args: &[String]) -> Result<Option<Value>> {
    if args.first().map(String::as_str) != Some("maintenance-recovery") {
        return Ok(None);
    }
    if args.len() == 2 && matches!(args[1].as_str(), "--help" | "-h") {
        return Ok(Some(
            json!({"ok":true,"kind":"maintenance-recovery-help","usage":USAGE}),
        ));
    }
    let mut flags = HashMap::new();
    let mut at = 1;
    while at < args.len() {
        let flag = args[at].as_str();
        if ![
            "--root",
            "--runtime-root",
            "--showcase-root",
            "--backup-id",
            "--apply-plan",
            "--out",
        ]
        .contains(&flag)
        {
            return Err(usage(format!("Unknown recovery argument: {flag}")));
        }
        let value = args
            .get(at + 1)
            .filter(|value| !value.is_empty() && !value.starts_with("--"))
            .ok_or_else(|| usage(format!("Missing value for {flag}")))?;
        if flags.insert(flag, value).is_some() {
            return Err(usage(format!("Duplicate recovery argument: {flag}")));
        }
        at += 2;
    }
    if flags.contains_key("--apply-plan")
        && (flags.contains_key("--out") || flags.contains_key("--backup-id"))
    {
        return Err(usage(
            "--apply-plan cannot be combined with --out or --backup-id",
        ));
    }
    let options = Options {
        assets_root: None,
        root: root(flags.get("--root").copied(), "--root")?,
        runtime: root(flags.get("--runtime-root").copied(), "--runtime-root")?,
        showcase: flags
            .get("--showcase-root")
            .map(|value| root(Some(value), "--showcase-root"))
            .transpose()?,
    };
    if let Some(file) = flags.get("--apply-plan") {
        return recovery::apply(
            &options,
            read_plan(&file_paths::absolute(Path::new(file))?)?,
        )
        .map(Some);
    }
    let plan = recovery::preview(&options, flags.get("--backup-id").map(|id| id.as_str()))?;
    if let Some(file) = flags.get("--out") {
        save_new(&file_paths::absolute(Path::new(file))?, &plan)?;
    }
    Ok(Some(plan))
}
