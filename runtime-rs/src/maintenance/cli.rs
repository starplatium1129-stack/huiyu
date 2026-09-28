use super::{Error, Options, Result, fs, recovery};
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
    fs::absolute(path)
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
        return recovery::apply(&options, read_plan(&fs::absolute(Path::new(file))?)?).map(Some);
    }
    let plan = recovery::preview(&options, flags.get("--backup-id").map(|id| id.as_str()))?;
    if let Some(file) = flags.get("--out") {
        save_new(&fs::absolute(Path::new(file))?, &plan)?;
    }
    Ok(Some(plan))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maintenance::{context::Context, identity, journal, transaction::Transaction};
    #[test]
    fn cli_preserves_reviewed_plan_and_requires_fresh_signature_before_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let app = directory.path().join("app");
        let runtime = directory.path().join("runtime");
        std::fs::create_dir_all(app.join("data")).unwrap();
        let file = app.join("data/tags-dictionary.json");
        let before = b"{\"version\":1,\"meanings\":{\"neutral\":\"fixture\"}}";
        std::fs::write(&file, before).unwrap();
        let options = Options {
            assets_root: None,
            root: app.clone(),
            runtime: runtime.clone(),
            showcase: None,
        };
        let args = vec![
            "maintenance-recovery".into(),
            "--root".into(),
            app.to_string_lossy().into_owned(),
            "--runtime-root".into(),
            runtime.to_string_lossy().into_owned(),
        ];
        assert!(
            run(&["--app-root".into(), app.to_string_lossy().into_owned()])
                .unwrap()
                .is_none()
        );
        let mut unsupported = args.clone();
        unsupported.push("--apply".into());
        assert_eq!(run(&unsupported).unwrap_err().code, "MAINTENANCE_USAGE");
        assert!(!runtime.exists());
        let mut transaction = Transaction::acquire(&options).unwrap();
        let backup = transaction
            .prepare(std::slice::from_ref(&file), "cli-fixture")
            .unwrap();
        transaction.write(&file, b"{\"partial\":true}").unwrap();
        drop(transaction);
        // Simulate only the dead-owner transition inside this disposable store;
        // the production recovery signer/backup/claim path remains unchanged.
        let ctx = Context::new(&options).unwrap();
        let mut value = journal::read(&ctx).unwrap().unwrap().value;
        let dead = 2_147_483_000_u64;
        assert_eq!(identity::process(dead), "dead");
        value["pid"] = dead.into();
        journal::write(&ctx, value).unwrap();
        let output = directory.path().join("reviewed-plan.json");
        let mut preview = args.clone();
        preview.extend([
            "--backup-id".into(),
            backup,
            "--out".into(),
            output.to_string_lossy().into_owned(),
        ]);
        let signed = run(&preview).unwrap().unwrap();
        assert_eq!(signed["executable"], true);
        assert_eq!(std::fs::read(&file).unwrap(), b"{\"partial\":true}");
        let saved = std::fs::read(&output).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&saved).unwrap(), signed);
        assert!(run(&preview).is_err());
        assert_eq!(saved, std::fs::read(&output).unwrap());
        let mut apply = args.clone();
        apply.extend(["--apply-plan".into(), output.to_string_lossy().into_owned()]);
        let mut tampered = signed.clone();
        tampered["action"] = "release-unstarted".into();
        std::fs::write(&output, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(run(&apply).is_err());
        std::fs::write(&output, &saved).unwrap();
        std::fs::write(&file, b"{\"changedAfterPreview\":true}").unwrap();
        assert!(run(&apply).is_err());
        let fresh = run(&args).unwrap().unwrap();
        std::fs::write(&output, serde_json::to_vec(&fresh).unwrap()).unwrap();
        let recovered = run(&apply).unwrap().unwrap();
        assert_eq!(recovered["ok"], true);
        assert_eq!(recovered["restoredFiles"], 1);
        assert_eq!(std::fs::read(file).unwrap(), before);
        assert_eq!(journal::inspect(&options)["status"], "free");
    }
}
