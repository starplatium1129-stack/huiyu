use super::{Error, Result, Value, config::Context, fs, manifest::Entry, policy, state};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};
use tokio_util::sync::CancellationToken;
#[derive(Clone, Debug)]
pub(super) struct Group {
    pub paths: Vec<String>,
    pub total_bytes: Option<u64>,
}
#[derive(Clone, Debug)]
pub(super) struct Snapshot {
    pub root: PathBuf,
    pub identity: String,
    pub sequence: u64,
    pub release_id: String,
    pub previous: bool,
    pub entries: HashMap<String, Entry>,
    pub verified_files: usize,
    pub groups: Vec<Group>,
    pub group_files: HashMap<String, (usize, usize)>,
}
pub(super) fn idle(ctx: &Context) -> Result<()> {
    if fs::safe(&ctx.store.join("pending.json"), true, false)?.is_some() {
        return Err(Error::new(
            "PENDING_TRANSACTION",
            "Explicit recovery required before mount",
        ));
    }
    let locks = ctx.store.join("locks");
    if let Some(stat) = fs::safe(&locks, true, false)? {
        if !stat.is_dir() {
            return Err(Error::new("STATE_INVALID", "Lock area is not directory"));
        }
        if std::fs::read_dir(locks)?.next().is_some() {
            return Err(Error::new("BUSY", "Resource lock exists"));
        }
    }
    Ok(())
}
type ControlBytes = (Option<Vec<u8>>, Option<Vec<u8>>);
fn controls(ctx: &Context) -> Result<ControlBytes> {
    ctx.access()?;
    let Some(stat) = fs::safe(&ctx.store, true, false)? else {
        return Ok((None, None));
    };
    if !stat.is_dir() {
        return Err(Error::new("UNOWNED_ROOT", "Store is not directory"));
    }
    let bytes = fs::bytes(&ctx.store.join("store.json"), fs::MAX_JSON, false)?;
    let marker: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::new("METADATA_INVALID", "Invalid ownership JSON"))?;
    if marker["schemaVersion"] != 1
        || marker["kind"] != "aics-resource-library"
        || marker.as_object().is_none_or(|object| object.len() != 2)
    {
        return Err(Error::new("UNOWNED_ROOT", "Ownership marker invalid"));
    }
    idle(ctx)?;
    let current = ctx.store.join("current.json");
    let current = if fs::safe(&current, true, false)?.is_some() {
        Some(fs::bytes(&current, fs::MAX_JSON, false)?)
    } else {
        None
    };
    Ok((Some(bytes), current))
}
pub(super) fn serviceable(path: &str) -> bool {
    if !path.starts_with("assets/") || path.split('/').any(|part| part.starts_with('.')) {
        return false;
    }
    let lower = path.to_lowercase();
    if lower == "assets/character-references"
        || lower.starts_with("assets/character-references/")
        || lower == "assets/live2d-candidates"
        || lower.starts_with("assets/live2d-candidates/")
    {
        return false;
    }
    if [
        ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".ico", ".mp3", ".ogg", ".wav", ".flac",
        ".m4a", ".mp4", ".webm",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
    {
        return true;
    }
    path.starts_with("assets/live2d/")
        && [
            ".moc",
            ".moc3",
            ".mtn",
            ".model.json",
            ".model3.json",
            ".physics.json",
            ".physics3.json",
            ".pose.json",
            ".pose3.json",
            ".motion3.json",
            ".exp.json",
            ".exp3.json",
            ".cdi3.json",
        ]
        .iter()
        .any(|ext| lower.ends_with(ext))
}
fn group(root: &std::path::Path, entry: &Entry, entries: &HashMap<String, Entry>) -> Result<Group> {
    let bytes = fs::bytes(&fs::child(root, &entry.path)?, fs::MAX_JSON, false)?;
    if super::digest(&bytes) != entry.sha256 {
        return Err(Error::new("CONTENT_INVALID", "Model metadata changed"));
    }
    let model: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::new("CONTENT_INVALID", "Model JSON invalid"))?;
    drop(bytes);
    let files = &model["FileReferences"];
    let textures = files["Textures"]
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| Error::new("CONTENT_INVALID", "Model textures missing"))?;
    if model["Version"] != 3 || !files["Moc"].is_string() {
        return Err(Error::new("CONTENT_INVALID", "Unsupported model schema"));
    }
    let mut refs = vec![&files["Moc"]];
    refs.extend(textures);
    for key in ["Physics", "Pose", "DisplayInfo", "UserData"] {
        if let Some(value) = files.get(key) {
            refs.push(value);
        }
    }
    if let Some(expressions) = files.get("Expressions") {
        for item in expressions
            .as_array()
            .ok_or_else(|| Error::new("CONTENT_INVALID", "Invalid model expressions"))?
        {
            refs.push(&item["File"]);
        }
    }
    if let Some(motions) = files.get("Motions") {
        for items in motions
            .as_object()
            .ok_or_else(|| Error::new("CONTENT_INVALID", "Invalid model motions"))?
            .values()
        {
            for item in items
                .as_array()
                .ok_or_else(|| Error::new("CONTENT_INVALID", "Invalid motion group"))?
            {
                refs.push(&item["File"]);
                if let Some(sound) = item.get("Sound") {
                    refs.push(sound);
                }
            }
        }
    }
    let directory = entry.path.rsplit_once('/').unwrap().0;
    let mut paths = vec![entry.path.clone()];
    let mut seen = HashSet::from([entry.path.as_str()]);
    for value in refs {
        let value = value
            .as_str()
            .ok_or_else(|| Error::new("UNSAFE_PATH", "Invalid model dependency"))?;
        fs::relative(value)?;
        if value.contains(['%', '#']) || value.split('/').any(|part| part.starts_with('.')) {
            return Err(Error::new("UNSAFE_PATH", "Unsafe model dependency"));
        }
        let path = format!("{directory}/{value}");
        let Some((stored_path, _)) = entries.get_key_value(&path) else {
            return Err(Error::new(
                "CONTENT_INVALID",
                "Model dependency missing from serving manifest",
            ));
        };
        if seen.insert(stored_path.as_str()) {
            paths.push(path);
        }
    }
    let total_bytes = paths
        .iter()
        .try_fold(0_u64, |total, name| total.checked_add(entries[name].bytes));
    Ok(Group { paths, total_bytes })
}
pub(super) fn snapshot(ctx: &Context, cancel: &CancellationToken) -> Result<Option<Snapshot>> {
    let before = controls(ctx)?;
    let Some(bytes) = &before.1 else {
        if before.0.is_some() {
            for name in ["versions", "transactions"] {
                let directory = ctx.store.join(name);
                if let Some(stat) = fs::safe(&directory, true, false)?
                    && (!stat.is_dir() || std::fs::read_dir(directory)?.next().is_some())
                {
                    return Err(Error::new(
                        "STATE_INVALID",
                        "Missing current pointer with existing history",
                    ));
                }
            }
        }
        if before != controls(ctx)? {
            return Err(Error::new(
                "STATE_CONFLICT",
                "Resource state changed during read",
            ));
        }
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| Error::new("METADATA_INVALID", "Installed state is not JSON"))?;
    state::validate(ctx, &value)?;
    for key in ["current", "previous"] {
        if !value[key].is_null() {
            let (approved, source) =
                policy::approved(ctx, value[key]["releaseId"].as_str().unwrap())?;
            if source["kind"] == "http" {
                policy::source_url(approved, source, "manifest.json")?;
            }
        }
    }
    if value["current"].is_null() {
        if value["sequence"] != 0 || !value["previous"].is_null() {
            return Err(Error::new(
                "STATE_INVALID",
                "Empty state has invalid history",
            ));
        }
        if before != controls(ctx)? {
            return Err(Error::new("STATE_CONFLICT", "State changed"));
        }
        return Ok(None);
    }
    if value["sequence"] == 0 {
        return Err(Error::new(
            "STATE_INVALID",
            "Installed state requires positive sequence",
        ));
    }
    let root = state::version_root(ctx, &value["current"])?;
    let raw = fs::bytes(&root.join("manifest.json"), fs::MAX_JSON, false)?;
    let receipt = fs::bytes(&root.join("receipt.json"), fs::MAX_JSON, false)?;
    let verified = state::verify(ctx, &value["current"], cancel)?;
    if raw != fs::bytes(&root.join("manifest.json"), fs::MAX_JSON, false)?
        || receipt != fs::bytes(&root.join("receipt.json"), fs::MAX_JSON, false)?
        || before != controls(ctx)?
    {
        return Err(Error::new(
            "STATE_CONFLICT",
            "Installed metadata changed during verification",
        ));
    }
    drop((raw, receipt, before));
    ctx.access()?;
    let verified_files = verified.manifest.entries.len();
    let entries = verified
        .manifest
        .entries
        .into_iter()
        .filter(|entry| serviceable(&entry.path))
        .map(|entry| (entry.path.clone(), entry))
        .collect::<HashMap<_, _>>();
    let mut ordered = entries
        .values()
        .filter(|entry| {
            entry.path.starts_with("assets/live2d/")
                && entry.path.to_lowercase().ends_with(".model3.json")
        })
        .collect::<Vec<_>>();
    ordered.sort_by(|a, b| a.path.encode_utf16().cmp(b.path.encode_utf16()));
    let groups = ordered
        .into_iter()
        .filter_map(|entry| group(&root, entry, &entries).ok())
        .collect::<Vec<_>>();
    let mut group_files = HashMap::new();
    for (group, value) in groups.iter().enumerate() {
        for (file, path) in value.paths.iter().enumerate() {
            // Shared dependencies keep the first validated group in model order.
            group_files.entry(path.clone()).or_insert((group, file));
        }
    }
    Ok(Some(Snapshot {
        root,
        identity: value["current"]["identity"].as_str().unwrap().into(),
        sequence: super::number(&value["sequence"]).unwrap(),
        release_id: value["current"]["releaseId"].as_str().unwrap().into(),
        previous: !value["previous"].is_null(),
        entries,
        verified_files,
        groups,
        group_files,
    }))
}
pub(super) fn mount(ctx: &Context, snapshot: &Snapshot) -> Result<()> {
    ctx.access()?;
    idle(ctx)?;
    let current = state::read(ctx)?;
    if current["sequence"] != snapshot.sequence
        || current["current"]["identity"] != snapshot.identity
    {
        return Err(Error::new("STATE_CONFLICT", "Installed pointer changed"));
    }
    fs::safe(&snapshot.root, false, false)?;
    Ok(())
}
