use super::super::resources::within;
use super::{Settings, path_eq, python_relative};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

pub(super) fn installed_runtime(root: &Path, worker: &Path) -> Option<(PathBuf, Value)> {
    installed_runtime_for(root, worker, "requirements.txt")
}
pub(crate) fn installed_adapter_runtime(root: &Path, worker: &Path) -> Option<(PathBuf, Value)> {
    installed_runtime_for(root, worker, "requirements-adapters.txt")
}

pub(in crate::generation::native) fn usable_python(python: &Path) -> bool {
    if !python.is_file() {
        return false;
    }
    let Some(bin) = python.parent() else {
        return false;
    };
    if !cfg!(windows)
        || !bin
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("Scripts"))
    {
        return true;
    }
    if bin
        .parent()
        .is_some_and(|venv| venv.join("pyvenv.cfg").is_file())
    {
        return true;
    }
    // Managed Windows packages can contain the embeddable interpreter directly under Scripts.
    std::fs::read_dir(bin).is_ok_and(|files| {
        files.flatten().any(|entry| {
            let path = entry.path();
            path.extension().is_some_and(|ext| ext == "_pth")
                && path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .and_then(|s| s.strip_prefix("python"))
                    .is_some_and(|version| {
                        !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit())
                    })
                && path.is_file()
                && path.with_extension("dll").is_file()
                && path.with_extension("zip").is_file()
        })
    })
}

/// The sd.cpp worker only imports Pillow. An existing managed image environment
/// can service it even when the current Diffusers requirements have changed.
pub(in crate::generation::native) fn sd_cpp_python(settings: &Settings) -> Option<PathBuf> {
    let root = settings.models_root.parent();
    let legacy = root
        .and_then(Path::parent)
        .map(|workspace| workspace.join("ComfyUI"));
    let standalone = |python: &Path| {
        usable_python(python)
            && !legacy
                .as_ref()
                .is_some_and(|old| within(old, python).is_some())
            && !python.ancestors().any(|p| {
                p.file_name()
                    .is_some_and(|n| n.eq_ignore_ascii_case("ComfyUI"))
            })
    };
    if let Some(python) = settings
        .adapter_python
        .as_deref()
        .filter(|path| standalone(path))
    {
        return Some(python.to_owned());
    }
    static MANAGED: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../../../tools/inference/managed-adapter-runtime.windows-x64.json"
        ))
        .expect("bundled native image runtime")
    });
    let managed = || {
        let root = root?;
        let id = MANAGED["runtimeId"].as_str()?;
        let folder = within(root, &root.join(id))?;
        let receipt = read_receipt(&within(&folder, &folder.join("runtime-config.json"))?)?;
        let python = within(&folder, &folder.join(python_relative()))?;
        (receipt["schemaVersion"] == 1
            && receipt["engine"] == "native"
            && receipt["managedRuntimeId"] == id
            && receipt["root"]
                .as_str()
                .is_some_and(|path| path_eq(Path::new(path), &folder))
            && receipt["python"]
                .as_str()
                .is_some_and(|path| path_eq(Path::new(path), &python))
            && usable_python(&python))
        .then_some(python)
    };
    managed().or_else(|| standalone(&settings.python).then(|| settings.python.clone()))
}

pub(crate) fn installed_runtime_for(
    root: &Path,
    worker: &Path,
    requirements_name: &str,
) -> Option<(PathBuf, Value)> {
    if std::fs::symlink_metadata(root)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let requirements = std::fs::read(worker.parent()?.join(requirements_name)).ok()?;
    let expected_hash = format!("{:x}", Sha256::digest(requirements));
    let mut candidates = vec![root.to_owned()];
    // Never recurse into virtual environments, model trees or arbitrary disks.
    // An oversized directory falls back to its own receipt, not an arbitrary subset.
    if let Ok(entries) = std::fs::read_dir(root) {
        let entries: Vec<_> = entries.take(129).collect();
        if entries.len() <= 128 {
            let mut folders: Vec<_> = entries
                .into_iter()
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path())
                .collect();
            folders.sort();
            candidates.extend(folders);
        }
    }
    for folder in candidates {
        let path = folder.join("runtime-config.json");
        if within(root, &path).is_none() {
            continue;
        }
        let Some(document) = read_receipt(&path) else {
            continue;
        };
        let Some(python) = document["python"].as_str().map(PathBuf::from) else {
            continue;
        };
        if document["schemaVersion"] != 1
            || document["engine"] != "native"
            || document["requirementsSha256"] != expected_hash
            || document["environment"]["cudaAvailable"] != true
            || !python.is_absolute()
            || !usable_python(&python)
            || within(&folder, &python).is_none()
            || python.canonicalize().ok() != folder.join(python_relative()).canonicalize().ok()
            || document["root"]
                .as_str()
                .and_then(|root| Path::new(root).canonicalize().ok())
                != folder.canonicalize().ok()
        {
            continue;
        }
        return Some((path, document));
    }
    None
}
fn read_receipt(path: &Path) -> Option<Value> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(65537)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
