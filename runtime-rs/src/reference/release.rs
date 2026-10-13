use super::{Result, invalid_release, io, shards};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

pub(super) struct Release {
    root: PathBuf,
    marker: Vec<u8>,
    manifest: Value,
    view: Value,
    files: HashMap<String, (u64, String)>,
}

#[derive(Debug)]
pub(super) struct Image {
    pub(super) bytes: Option<Vec<u8>>,
    pub(super) length: u64,
    pub(super) hash: String,
}

fn hash_matches(bytes: &[u8], expected: &Value) -> bool {
    expected
        .as_str()
        .is_some_and(|hash| hash.len() == 64 && io::digest(bytes) == hash)
}

pub(super) fn seal(release: &Value) -> String {
    let mut fields = Map::new();
    for key in [
        "files",
        "viewSha256",
        "sourceStandardsSha256",
        "sourceViewSha256",
        "candidateManifestSha256",
        "reviewSha256",
        "baseIdentity",
    ] {
        if let Some(value) = release.get(key) {
            fields.insert(key.into(), value.clone());
        }
    }
    if release.get("approvals").is_some_and(truthy) {
        fields.insert("approvals".into(), release["approvals"].clone());
    }
    io::digest(crate::storage::stringify(&Value::Object(fields)))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn relative_image(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    parts.len() >= 2
        && ["png", "webp", "jpg", "jpeg"].contains(&extension.as_str())
        && parts.iter().all(|part| {
            let base = part.split('.').next().unwrap_or("").to_ascii_lowercase();
            !part.is_empty()
                && part
                    .bytes()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                && !part.ends_with('.')
                && !["con", "prn", "aux", "nul"].contains(&base.as_str())
                && !((base.starts_with("com") || base.starts_with("lpt"))
                    && base.len() == 4
                    && matches!(base.as_bytes()[3], b'1'..=b'9'))
        })
}

fn scan(root: &Path, directory: &Path, found: &mut HashMap<String, (u64, String)>) -> Result<()> {
    io::no_links(directory)?;
    for entry in fs::read_dir(directory).map_err(|_| invalid_release())? {
        let entry = entry.map_err(|_| invalid_release())?;
        let file = entry.path();
        io::no_links(&file)?;
        let metadata = entry.metadata().map_err(|_| invalid_release())?;
        if metadata.is_dir() {
            scan(root, &file, found)?;
            continue;
        }
        let relative = file
            .strip_prefix(root)
            .map_err(|_| invalid_release())?
            .to_str()
            .ok_or_else(invalid_release)?
            .replace('\\', "/");
        if ["reference-release.json", "character-reference-view.json"].contains(&relative.as_str())
        {
            continue;
        }
        if !relative_image(&relative) {
            return Err(invalid_release());
        }
        if found.insert(relative, io::file_digest(&file)?).is_some() {
            return Err(invalid_release());
        }
    }
    Ok(())
}

fn validate_view(view: &Value, paths: &HashSet<&str>) -> Result<()> {
    for character in view.as_object().ok_or_else(invalid_release)?.values() {
        let Some(outfits) = character.get("outfits") else {
            continue;
        };
        for outfit in outfits.as_array().ok_or_else(invalid_release)? {
            let Some(references) = outfit.get("references") else {
                continue;
            };
            for reference in references.as_array().ok_or_else(invalid_release)? {
                if reference.get("pending").is_some_and(truthy) {
                    continue;
                }
                if let Some(relative) = reference["url"]
                    .as_str()
                    .and_then(|url| url.strip_prefix("/character-references/"))
                    && (!relative_image(relative) || !paths.contains(relative))
                {
                    return Err(invalid_release());
                }
            }
        }
    }
    Ok(())
}

impl Release {
    pub(super) fn open(root: &Path, app_root: &Path) -> Result<Option<Self>> {
        io::no_links(root)?;
        if !root.is_dir() {
            return Err(invalid_release());
        }
        let marker_path = root.join("reference-release.json");
        io::no_links(&marker_path)?;
        if !marker_path.try_exists().map_err(|_| invalid_release())? {
            return Ok(None);
        }
        let marker = io::bytes(&marker_path)?;
        let manifest: Value = serde_json::from_slice(&marker).map_err(|_| invalid_release())?;
        if manifest["schemaVersion"] != 1
            || manifest["kind"] != "reference-release"
            || manifest["identity"].as_str() != Some(&seal(&manifest))
        {
            return Err(invalid_release());
        }
        let entries = manifest["files"].as_array().ok_or_else(invalid_release)?;
        let mut actual = HashMap::new();
        scan(root, root, &mut actual)?;
        let mut case_keys = HashSet::new();
        let mut paths = HashSet::new();
        let mut files = HashMap::new();
        for entry in entries {
            let relative = entry["path"].as_str().ok_or_else(invalid_release)?;
            if !relative_image(relative) || !case_keys.insert(relative.to_ascii_lowercase()) {
                return Err(invalid_release());
            }
            let (size, hash) = actual.remove(relative).ok_or_else(invalid_release)?;
            if entry["bytes"].as_u64() != Some(size) || entry["sha256"].as_str() != Some(&hash) {
                return Err(invalid_release());
            }
            paths.insert(relative);
            files.insert(relative.to_owned(), (size, hash));
        }
        if !actual.is_empty() {
            return Err(invalid_release());
        }
        let view_bytes = io::bytes(&root.join("character-reference-view.json"))?;
        let standards = io::bytes(&app_root.join("data/character-reference-standards.json"))?;
        let source_view = io::bytes(&app_root.join("data/character-reference-view.json"))?;
        if !hash_matches(&view_bytes, &manifest["viewSha256"])
            || !hash_matches(&standards, &manifest["sourceStandardsSha256"])
            || !hash_matches(&source_view, &manifest["sourceViewSha256"])
        {
            return Err(invalid_release());
        }
        shards::check_products(app_root, &standards, &source_view)?;
        let view: Value = serde_json::from_slice(&view_bytes).map_err(|_| invalid_release())?;
        validate_view(&view, &paths)?;
        // Full image verification happens once, using bounded streaming hashes.
        // Subsequent profile reads revalidate the control bytes but reuse parsed JSON.
        Ok(Some(Self {
            root: root.to_owned(),
            marker,
            manifest,
            view,
            files,
        }))
    }

    pub(super) fn read(&self, app_root: &Path, id: Option<&str>) -> Result<Option<Value>> {
        self.controls(app_root)?;
        Ok(match id {
            Some(id) => self.view.get(id).cloned().filter(truthy),
            None => Some(self.view.clone()),
        })
    }
    fn controls(&self, app_root: &Path) -> Result<()> {
        if io::bytes(&self.root.join("reference-release.json"))? != self.marker {
            return Err(invalid_release());
        }
        for (path, key) in [
            (
                self.root.join("character-reference-view.json"),
                "viewSha256",
            ),
            (
                app_root.join("data/character-reference-standards.json"),
                "sourceStandardsSha256",
            ),
            (
                app_root.join("data/character-reference-view.json"),
                "sourceViewSha256",
            ),
        ] {
            let (_, hash) = io::file_digest(&path)?;
            if self.manifest[key].as_str() != Some(&hash) {
                return Err(invalid_release());
            }
        }
        Ok(())
    }
    pub(super) fn image(
        &self,
        app_root: &Path,
        relative: &str,
        collect: impl FnOnce(&str) -> bool,
    ) -> Result<Option<Image>> {
        self.controls(app_root)?;
        if !relative_image(relative) {
            return Ok(None);
        }
        let Some((expected_length, expected_hash)) = self.files.get(relative) else {
            return Ok(None);
        };
        let path = self.root.join(relative);
        // HEAD and conditional hits still verify all image bytes, but do not
        // retain an image-sized allocation for a response with no body.
        let (bytes, length, hash) = if collect(expected_hash) {
            let bytes = io::bytes(&path)?;
            let length = bytes.len() as u64;
            let hash = io::digest(&bytes);
            (Some(bytes), length, hash)
        } else {
            let (length, hash) = io::file_digest(&path)?;
            (None, length, hash)
        };
        if length != *expected_length || hash != *expected_hash {
            return Err(invalid_release());
        }
        self.controls(app_root)?;
        Ok(Some(Image {
            bytes,
            length,
            hash,
        }))
    }
}
