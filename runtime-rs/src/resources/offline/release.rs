use super::{Error, Options, Result, Value, config, fs, json};
use crate::resources::{
    digest, equal, hash, identifier,
    manifest::{self, Entry, Manifest},
    number, policy, resolve,
};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    path::PathBuf,
};
use tokio_util::sync::CancellationToken;

pub(super) struct Release {
    pub catalog: Option<Value>,
    pub id: String,
    pub app_version: String,
    pub approved: Value,
    pub assets: Manifest,
    pub showcase_root: PathBuf,
    pub showcase: Manifest,
    // Readers share the immutable inventory validated by load.
    showcase_identity: String,
    showcase_payload: Option<Manifest>,
    pub baseline: Option<Value>,
    pub display: Value,
    pub files: usize,
    pub bytes: u64,
}
impl Release {
    pub(super) fn showcase_payload(&self) -> &Manifest {
        self.showcase_payload.as_ref().unwrap_or(&self.showcase)
    }
    pub(super) fn showcase_identity(&self) -> &str {
        &self.showcase_identity
    }
}
fn entries(value: &Value) -> Result<Vec<Entry>> {
    let items = value
        .as_array()
        .ok_or_else(|| Error::new("MANIFEST_INVALID", "File inventory required"))?;
    if items.len() > 100_000 {
        return Err(Error::new("MANIFEST_INVALID", "File inventory too large"));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    let mut total = 0_u64;
    for item in items {
        let path = item["path"].as_str().unwrap_or("");
        fs::relative(path)?;
        let bytes = number(&item["bytes"])
            .ok_or_else(|| Error::new("MANIFEST_INVALID", "Invalid file size"))?;
        let sha256 = item["sha256"].as_str().unwrap_or("");
        if path.contains('%') || !hash(sha256) || !seen.insert(path.to_lowercase()) {
            return Err(Error::new(
                "MANIFEST_INVALID",
                "Invalid or duplicate inventory path/hash",
            ));
        }
        total = total
            .checked_add(bytes)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(|| Error::new("SIZE_INVALID", "File inventory total overflow"))?;
        result.push(Entry {
            path: path.into(),
            bytes,
            sha256: sha256.into(),
        });
    }
    Ok(result)
}
pub(super) fn media(path: &str) -> bool {
    static ALLOWED: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^(?:images|thumbs)/(?:sc\d{3,}|artist_[a-zA-Z0-9_-]+|pc_[a-zA-Z0-9_-]+|lora_[a-zA-Z0-9_-]+)\.(?:jpg|png|webp)$").unwrap()
    });
    ALLOWED.is_match(path)
}
pub(super) fn display(value: &Value) -> Result<HashMap<String, Cow<'_, Value>>> {
    let items = value["entries"]
        .as_array()
        .filter(|items| items.len() <= 100_000)
        .ok_or_else(|| Error::new("MANIFEST_INVALID", "Invalid showcase entries"))?;
    let mut result = HashMap::new();
    for item in items {
        let id = item["id"].as_str().unwrap_or("");
        if id.is_empty()
            || id.len() > 200
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            || !matches!(item["rating"].as_str(), Some("All" | "R15" | "R18"))
        {
            return Err(Error::new(
                "MANIFEST_INVALID",
                "Invalid or duplicate showcase entry",
            ));
        }
        let mut normalized = Cow::Borrowed(item);
        for (field, folder) in [("image", "images"), ("thumb", "thumbs")] {
            let path: Cow<'_, str> = match item.get(field) {
                None | Some(Value::Null) => Cow::Owned(format!("{folder}/{id}.jpg")),
                Some(Value::String(value)) if value.is_empty() => {
                    Cow::Owned(format!("{folder}/{id}.jpg"))
                }
                Some(Value::String(value)) => Cow::Borrowed(value),
                _ => {
                    return Err(Error::new(
                        "MANIFEST_INVALID",
                        "Invalid showcase media field",
                    ));
                }
            };
            if !media(&path) {
                return Err(Error::new(
                    "MANIFEST_INVALID",
                    "Invalid showcase media path",
                ));
            }
            if let Cow::Owned(path) = path {
                normalized.to_mut()[field] = path.into();
            }
        }
        if result.insert(id.to_lowercase(), normalized).is_some() {
            return Err(Error::new("MANIFEST_INVALID", "Duplicate showcase entry"));
        }
    }
    Ok(result)
}
pub(super) fn load(options: &Options, cancel: &CancellationToken) -> Result<Release> {
    config::cancelled(cancel)?;
    let raw = fs::bytes(&options.package.join("release.json"), fs::MAX_JSON, false)?;
    let release_bytes = raw.len() as u64;
    if digest(&raw) != options.expected {
        return Err(Error::new(
            "PACKAGE_UNAPPROVED",
            "release.json differs from the SHA256 chosen from the trusted release page",
        ));
    }
    let mut value: Value = serde_json::from_slice(&raw)
        .map_err(|_| Error::new("MANIFEST_INVALID", "Invalid release JSON"))?;
    drop(raw);
    let id = value["releaseId"]
        .as_str()
        .filter(|id| identifier(id))
        .ok_or_else(|| Error::new("MANIFEST_INVALID", "Invalid release ID"))?;
    let app_version = value["appVersion"]
        .as_str()
        .filter(|version| {
            !version.is_empty()
                && version.len() <= 64
                && version
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-_+".contains(&byte))
        })
        .ok_or_else(|| Error::new("MANIFEST_INVALID", "Invalid app version"))?;
    if value["schemaVersion"] != 1
        || value["kind"] != "huiyu-offline-release"
        || value["resourcePack"]["path"] != "pack"
        || value["showcase"]["path"] != "showcase"
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Unsupported offline release schema",
        ));
    }
    let incremental = value["mode"] == "delta";
    if !value["mode"].is_null() && value["mode"] != "full" && !incremental {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Unknown offline release mode",
        ));
    }
    let baseline = incremental.then(|| value["baseRelease"].clone());
    if let Some(base) = &baseline
        && (!identifier(base["releaseId"].as_str().unwrap_or(""))
            || ["releaseSha256", "resourceIdentity", "showcaseIdentity"]
                .iter()
                .any(|key| !hash(base[key].as_str().unwrap_or(""))))
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Invalid incremental baseline",
        ));
    }
    let approved = json!({"approved":true,"kind":if incremental {"delta"}else{"full"},"sourceId":id,"path":"pack","packageIdentity":value["resourcePack"]["packageIdentity"],"targetIdentity":value["resourcePack"]["targetIdentity"],"releaseSha256":options.expected,"label":format!("离线资源 {id}")});
    if !hash(approved["packageIdentity"].as_str().unwrap_or(""))
        || !hash(approved["targetIdentity"].as_str().unwrap_or(""))
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Invalid resource identities",
        ));
    }
    let pack_raw = fs::bytes(
        &options.package.join("pack/manifest.json"),
        fs::MAX_JSON,
        false,
    )?;
    let delta_raw = if incremental {
        Some(fs::bytes(
            &options.package.join("pack/delta.json"),
            fs::MAX_JSON,
            false,
        )?)
    } else {
        None
    };
    let pack = policy::decode(pack_raw, delta_raw, &approved)?;
    if let Some(base) = &baseline
        && pack.delta.as_ref().unwrap()["baseManifest"]["contentIdentity"]
            != base["resourceIdentity"]
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Asset delta baseline differs from offline baseline",
        ));
    }
    if (!incremental && pack.manifest.entries.is_empty())
        || pack
            .manifest
            .entries
            .iter()
            .any(|entry| !resolve::serviceable(&entry.path))
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Offline pack must contain only serviceable public assets",
        ));
    }
    let showcase = Manifest {
        entries: entries(&value["showcase"]["entries"])?,
    };
    if showcase.entries.is_empty()
        || showcase
            .entries
            .iter()
            .any(|entry| entry.path != "manifest.json" && !media(&entry.path))
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Invalid showcase paths or identity",
        ));
    }
    let showcase_identity = showcase.identity();
    if showcase_identity != value["showcase"]["contentIdentity"] {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Invalid showcase paths or identity",
        ));
    }
    let showcase_root = options.package.join("showcase");
    let showcase_payload = if incremental {
        Some(Manifest {
            entries: entries(&value["showcase"]["payloadEntries"])?,
        })
    } else {
        None
    };
    let payload = showcase_payload.as_ref().unwrap_or(&showcase);
    let showcase_entries = showcase
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<HashMap<_, _>>();
    if !payload
        .entries
        .iter()
        .any(|entry| entry.path == "manifest.json")
        || payload
            .entries
            .iter()
            .any(|entry| showcase_entries.get(entry.path.as_str()).copied() != Some(entry))
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Invalid incremental showcase payload",
        ));
    }
    drop(showcase_entries);
    let display_raw = fs::bytes(&showcase_root.join("manifest.json"), fs::MAX_JSON, false)?;
    if !payload.entries.iter().any(|entry| {
        entry.path == "manifest.json"
            && entry.bytes == display_raw.len() as u64
            && entry.sha256 == digest(&display_raw)
    }) {
        return Err(Error::new(
            "CONTENT_INVALID",
            "Showcase manifest differs from release",
        ));
    }
    let display_value: Value = serde_json::from_slice(&display_raw)
        .map_err(|_| Error::new("MANIFEST_INVALID", "Invalid display manifest"))?;
    drop(display_raw);
    let mut referenced = HashSet::from(["manifest.json".to_string()]);
    for item in display(&display_value)?.values() {
        for field in ["image", "thumb"] {
            referenced.insert(item[field].as_str().unwrap().into());
        }
    }
    // entries() already rejects duplicate paths.
    if referenced.len() != showcase.entries.len()
        || showcase
            .entries
            .iter()
            .any(|entry| !referenced.contains(&entry.path))
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Showcase inventory must equal the actual referenced originals and thumbnails",
        ));
    }
    drop(referenced);
    let inventory = Manifest {
        entries: entries(&value["files"])?,
    };
    let mut expected = vec![Entry {
        path: "pack/manifest.json".into(),
        bytes: pack.raw.len() as u64,
        sha256: digest(&pack.raw),
    }];
    if let Some(raw) = &pack.delta_raw {
        expected.push(Entry {
            path: "pack/delta.json".into(),
            bytes: raw.len() as u64,
            sha256: digest(raw),
        });
    }
    drop((pack.raw, pack.delta_raw, pack.delta));
    expected.extend(pack.manifest.entries.iter().map(|entry| Entry {
        path: format!("pack/{}", entry.path),
        bytes: entry.bytes,
        sha256: entry.sha256.clone(),
    }));
    expected.extend(payload.entries.iter().map(|entry| Entry {
        path: format!("showcase/{}", entry.path),
        bytes: entry.bytes,
        sha256: entry.sha256.clone(),
    }));
    if !value["catalog"].is_null() {
        let catalog = entries(&json!([value["catalog"]]))?;
        if catalog[0].path != "catalog.json" || catalog[0].bytes > fs::MAX_JSON {
            return Err(Error::new(
                "MANIFEST_INVALID",
                "Invalid content catalog inventory",
            ));
        }
        expected.extend(catalog);
    }
    let expected = Manifest { entries: expected };
    if inventory.identity() != expected.identity()
        || inventory.entries.len() != expected.entries.len()
    {
        return Err(Error::new(
            "MANIFEST_INVALID",
            "Release files differ from asset/showcase inventories",
        ));
    }
    drop(expected);
    let id = id.to_owned();
    let app_version = app_version.to_owned();
    let catalog_entry = value
        .get_mut("catalog")
        .map(Value::take)
        .unwrap_or(Value::Null);
    drop(value);
    // The exact union above covers both payloads and their metadata. This
    // traversal checks every path, size and hash; verifying each subtree again
    // would immediately read and hash all payload bytes a second time.
    if !options.mount_directory {
        manifest::verify(&options.package, &inventory, &["release.json"], cancel)?;
    }
    let files = inventory.entries.len() + 1;
    let bytes = inventory.bytes() + release_bytes;
    drop(inventory);
    let catalog = if catalog_entry.is_null() {
        None
    } else {
        let raw = fs::bytes(&options.package.join("catalog.json"), fs::MAX_JSON, false)?;
        if digest(&raw) != catalog_entry["sha256"]
            || Some(raw.len() as u64) != number(&catalog_entry["bytes"])
        {
            return Err(Error::new(
                "CONTENT_INVALID",
                "Content catalog changed after verification",
            ));
        }
        let snapshot: Value = serde_json::from_slice(&raw)
            .map_err(|_| Error::new("METADATA_INVALID", "Invalid content catalog JSON"))?;
        if snapshot["version"] != 1 || snapshot["records"].as_array().is_none_or(Vec::is_empty) {
            return Err(Error::new(
                "MANIFEST_INVALID",
                "Invalid content catalog snapshot",
            ));
        }
        Some(snapshot)
    };
    Ok(Release {
        catalog,
        id,
        app_version,
        approved,
        assets: pack.manifest,
        showcase_root,
        showcase,
        showcase_identity,
        showcase_payload,
        baseline,
        display: display_value,
        files,
        bytes,
    })
}
pub(super) fn same_entry(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => equal(left, right),
        (None, None) => true,
        _ => false,
    }
}
