use std::path::Path;
use tokio::process::Command;

/// Shared native worker/helper policy. Callers own arguments, I/O and lifetime.
/// Keep installed sources read-only and independent of the caller's Python env.
pub(crate) fn command(python: &Path, script: &Path) -> Command {
    let mut command = Command::new(python);
    command
        .args(["-I", "-B", "-u", "-X", "utf8"])
        .arg(script)
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1");
    command
}
