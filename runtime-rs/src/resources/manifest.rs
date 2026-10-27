use super::{Error, Result, Value, fs, number};
use serde::Serializer as _;
use serde::ser::SerializeStruct as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    collections::HashSet,
    io::{self, BufWriter, Write},
    path::Path,
};
use tokio_util::sync::CancellationToken;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Entry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug)]
pub(super) struct Manifest {
    pub entries: Vec<Entry>,
}
struct IdentityFormatter;
impl serde_json::ser::Formatter for IdentityFormatter {
    fn write_u64<W: Write + ?Sized>(&mut self, writer: &mut W, value: u64) -> io::Result<()> {
        // Preserve canonical JSON's ECMAScript number normalization, including
        // entries deserialized directly with values above the safe integer range.
        writer.write_all(ryu_js::Buffer::new().format(value as f64).as_bytes())
    }
}
fn excluded(path: &str) -> bool {
    ["assets/character-references", "assets/live2d-candidates"]
        .iter()
        .any(|prefix| {
            path == *prefix
                || path
                    .strip_prefix(prefix)
                    .is_some_and(|tail| tail.starts_with('/'))
        })
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
        Self::from_fields(items.iter().map(|item| {
            (
                item["path"].as_str(),
                number(&item["bytes"]),
                item["sha256"].as_str(),
            )
        }))
    }
    pub(super) fn from_fields<'a>(
        items: impl IntoIterator<Item = (Option<&'a str>, Option<u64>, Option<&'a str>)>,
    ) -> Result<Self> {
        let mut entries = Vec::new();
        let mut identities = HashSet::new();
        let mut total = 0_u64;
        for (path, bytes, hash) in items {
            let path = path.ok_or_else(|| Error::new("MANIFEST_INVALID", "Missing path"))?;
            let bytes = bytes.ok_or_else(|| {
                Error::new(
                    "MANIFEST_INVALID",
                    "Byte length must be safe nonnegative integer",
                )
            })?;
            let hash = hash.unwrap_or("").to_lowercase();
            if !super::hash(&hash) {
                return Err(Error::new("MANIFEST_INVALID", "Invalid SHA256"));
            }
            let decoded: Cow<'_, [u8]> = percent_encoding::percent_decode_str(path).into();
            let lowered = path.to_lowercase();
            let platform_path = if cfg!(windows) {
                lowered.as_str()
            } else {
                path
            };
            if !path.starts_with("assets/")
                || path
                    .chars()
                    .any(|c| c <= '\u{1f}' || c == '\u{7f}' || "\\:".contains(c))
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || excluded(platform_path)
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
            if excluded(&lowered) {
                return Err(Error::new("UNSAFE_PATH", "Excluded resource domain"));
            }
            let extension = path.rsplit('.').next().unwrap_or("");
            if [
                "exe", "dll", "com", "bat", "cmd", "ps1", "psm1", "sh", "bash", "msi", "msp",
                "scr", "vbs", "vbe", "hta", "js", "mjs", "cjs", "html", "htm", "wasm",
            ]
            .iter()
            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
            {
                return Err(Error::new(
                    "EXECUTABLE_REJECTED",
                    "Executable resource rejected",
                ));
            }
            if !identities.insert(lowered) {
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
    pub fn encoded(&self) -> Vec<u8> {
        let mut body = Vec::new();
        let mut serializer = serde_json::Serializer::with_formatter(&mut body, IdentityFormatter);
        let mut value = serializer
            .serialize_struct("Manifest", 4)
            .expect("Manifest serialization is infallible");
        value
            .serialize_field("schemaVersion", &1_u8)
            .expect("Manifest serialization is infallible");
        value
            .serialize_field("kind", "resource-manifest")
            .expect("Manifest serialization is infallible");
        value
            .serialize_field("entries", &self.entries)
            .expect("Manifest serialization is infallible");
        value
            .serialize_field("unverified", &[] as &[Value])
            .expect("Manifest serialization is infallible");
        value.end().expect("Manifest serialization is infallible");
        body
    }
    pub fn identity(&self) -> String {
        let mut entries = self.entries.iter().collect::<Vec<_>>();
        entries.sort_by(|a, b| a.path.encode_utf16().cmp(b.path.encode_utf16()));
        let mut output = BufWriter::with_capacity(8 * 1024, Sha256::new());
        serde_json::Serializer::with_formatter(&mut output, IdentityFormatter)
            .collect_seq(
                entries
                    .into_iter()
                    .map(|entry| (&entry.path, entry.bytes, &entry.sha256)),
            )
            .expect("Manifest identity serialization is infallible");
        output.flush().expect("Hash writer is infallible");
        hex::encode(output.into_inner().unwrap().finalize())
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
        .map(|entry| entry.path.as_str())
        .chain(metadata.iter().copied())
        .collect::<HashSet<_>>();
    let mut directories = HashSet::from(["assets"]);
    for file in &declared {
        let mut current = *file;
        while let Some((parent, _)) = current.rsplit_once('/') {
            directories.insert(parent);
            current = parent;
        }
    }
    fn visit<'a>(
        root: &Path,
        dir: &Path,
        declared: &HashSet<&'a str>,
        directories: &HashSet<&str>,
        seen: &mut HashSet<&'a str>,
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
                if !directories.contains(relative.as_str()) {
                    return Err(Error::new("UNLISTED_FILE", "Undeclared directory"));
                }
                visit(root, &file, declared, directories, seen, cancel)?;
            } else {
                let Some(&name) = declared.get(relative.as_str()) else {
                    return Err(Error::new("UNLISTED_FILE", "Undeclared file"));
                };
                seen.insert(name);
            }
        }
        Ok(())
    }
    let mut seen = HashSet::new();
    visit(root, root, &declared, &directories, &mut seen, cancel)?;
    if seen.len() != declared.len() {
        return Err(Error::new("CONTENT_INVALID", "Resource tree incomplete"));
    }
    drop((seen, directories, declared));
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
