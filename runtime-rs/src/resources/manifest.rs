use super::{Error, Result, Value, fs, json, number};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};
use tokio_util::sync::CancellationToken;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Entry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug)]
pub(super) struct Manifest {
    pub entries: Vec<Entry>,
}
impl Manifest {
    pub fn parse(value: &Value) -> Result<Self> {
        if value["schemaVersion"] != 1
            || value
                .get("unverified")
                .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty))
        {
            return Err(Error::new(
                "MANIFEST_INVALID",
                "Manifest structure invalid or unverified",
            ));
        }
        let items = value["entries"]
            .as_array()
            .ok_or_else(|| Error::new("MANIFEST_INVALID", "Entries must be an array"))?;
        let mut entries = Vec::new();
        let mut identities = HashSet::new();
        let mut total = 0_u64;
        for item in items {
            let path = item["path"]
                .as_str()
                .ok_or_else(|| Error::new("MANIFEST_INVALID", "Missing path"))?;
            let bytes = number(&item["bytes"]).ok_or_else(|| {
                Error::new(
                    "MANIFEST_INVALID",
                    "Byte length must be safe nonnegative integer",
                )
            })?;
            let hash = item["sha256"].as_str().unwrap_or("").to_lowercase();
            if !super::hash(&hash) {
                return Err(Error::new("MANIFEST_INVALID", "Invalid SHA256"));
            }
            let decoded = percent_encoding::percent_decode_str(path).collect::<Vec<_>>();
            let lowered = if cfg!(windows) {
                path.to_lowercase()
            } else {
                path.into()
            };
            if !path.starts_with("assets/")
                || path
                    .chars()
                    .any(|c| c <= '\u{1f}' || c == '\u{7f}' || "\\:".contains(c))
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || ["assets/character-references", "assets/live2d-candidates"]
                    .iter()
                    .any(|prefix| lowered == *prefix || lowered.starts_with(&format!("{prefix}/")))
                || decoded
                    .iter()
                    .any(|byte| *byte <= 31 || *byte == 127 || b"\\:".contains(byte))
                || decoded.split(|byte| *byte == b'/').count() != path.split('/').count()
                || decoded
                    .split(|byte| *byte == b'/')
                    .any(|part| part == b"." || part == b".." || part.is_empty())
            {
                return Err(Error::new(
                    "MANIFEST_INVALID",
                    "Manifest path outside resource domain",
                ));
            }
            fs::relative(path)?;
            if !path.starts_with("assets/")
                || ["assets/character-references", "assets/live2d-candidates"]
                    .iter()
                    .any(|prefix| {
                        path.to_lowercase() == *prefix
                            || path.to_lowercase().starts_with(&format!("{prefix}/"))
                    })
            {
                return Err(Error::new("UNSAFE_PATH", "Excluded resource domain"));
            }
            let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if [
                "exe", "dll", "com", "bat", "cmd", "ps1", "psm1", "sh", "bash", "msi", "msp",
                "scr", "vbs", "vbe", "hta", "js", "mjs", "cjs", "html", "htm", "wasm",
            ]
            .contains(&extension.as_str())
            {
                return Err(Error::new(
                    "EXECUTABLE_REJECTED",
                    "Executable resource rejected",
                ));
            }
            if !identities.insert(path.to_lowercase()) {
                return Err(Error::new(
                    "MANIFEST_INVALID",
                    "Case insensitive duplicate path",
                ));
            }
            total = total
                .checked_add(bytes)
                .filter(|total| *total <= 9_007_199_254_740_991)
                .ok_or_else(|| Error::new("SIZE_INVALID", "Byte total exceeds safe integer"))?;
            entries.push(Entry {
                path: path.into(),
                bytes,
                sha256: hash,
            });
        }
        for identity in &identities {
            let mut current = identity.as_str();
            while let Some((parent, _)) = current.rsplit_once('/') {
                if identities.contains(parent) {
                    return Err(Error::new(
                        "MANIFEST_INVALID",
                        "File also used as directory",
                    ));
                }
                current = parent;
            }
        }
        Ok(Self { entries })
    }
    pub fn value(&self) -> Value {
        json!({"schemaVersion":1,"kind":"resource-manifest","entries":self.entries,"unverified":[]})
    }
    pub fn identity(&self) -> String {
        let mut entries = self.entries.iter().collect::<Vec<_>>();
        entries.sort_by(|a, b| a.path.encode_utf16().cmp(b.path.encode_utf16()));
        super::digest(
            crate::storage::stringify(&json!(
                entries
                    .iter()
                    .map(|entry| json!([entry.path, entry.bytes, entry.sha256]))
                    .collect::<Vec<_>>()
            ))
            .as_bytes(),
        )
    }
    pub fn bytes(&self) -> u64 {
        self.entries.iter().map(|entry| entry.bytes).sum()
    }
}
pub(super) fn verify(
    root: &Path,
    manifest: &Manifest,
    metadata: &[&str],
    cancel: &CancellationToken,
) -> Result<()> {
    if !fs::safe(root, false, false)?.unwrap().is_dir() {
        return Err(Error::new("UNSAFE_PATH", "Resource root is not directory"));
    }
    let declared = manifest
        .entries
        .iter()
        .map(|entry| entry.path.clone())
        .chain(metadata.iter().map(|name| (*name).into()))
        .collect::<HashSet<_>>();
    let mut directories = HashSet::from(["assets".to_owned()]);
    for file in &declared {
        let mut current = file.as_str();
        while let Some((parent, _)) = current.rsplit_once('/') {
            directories.insert(parent.into());
            current = parent;
        }
    }
    fn visit(
        root: &Path,
        dir: &Path,
        declared: &HashSet<String>,
        directories: &HashSet<String>,
        seen: &mut HashSet<String>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        fs::safe(dir, false, false)?;
        for item in std::fs::read_dir(dir)? {
            super::config::cancelled(cancel)?;
            let file = item?.path();
            let relative = file
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            fs::relative(&relative)?;
            let stat = fs::safe(&file, false, false)?.unwrap();
            if stat.is_dir() {
                if !directories.contains(&relative) {
                    return Err(Error::new("UNLISTED_FILE", "Undeclared directory"));
                }
                visit(root, &file, declared, directories, seen, cancel)?;
            } else {
                if !declared.contains(&relative) {
                    return Err(Error::new("UNLISTED_FILE", "Undeclared file"));
                }
                seen.insert(relative);
            }
        }
        Ok(())
    }
    let mut seen = HashSet::new();
    visit(root, root, &declared, &directories, &mut seen, cancel)?;
    if seen.len() != declared.len() {
        return Err(Error::new("CONTENT_INVALID", "Resource tree incomplete"));
    }
    for entry in &manifest.entries {
        if !fs::file_matches(&fs::child(root, &entry.path)?, entry, cancel)? {
            return Err(Error::new(
                "CONTENT_INVALID",
                "Resource bytes failed verification",
            ));
        }
    }
    Ok(())
}
