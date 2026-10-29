use super::{Error, Result, Value, config::Context, fs, manifest::Entry, policy, state};
use std::{collections::HashMap, path::PathBuf};
use tokio_util::sync::CancellationToken;
#[derive(Clone, Debug)]
pub(super) struct Snapshot {
    pub root: PathBuf,
    pub identity: String,
    pub sequence: u64,
    pub release_id: String,
    pub previous: bool,
    pub entries: HashMap<String, Entry>,
    pub files: usize,
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
pub(super) fn snapshot(ctx: &Context, cancel: &CancellationToken) -> Result<Option<Snapshot>> {
    if let Some(directory) = &ctx.directory {
        ctx.access()?;
        return directory.snapshot(cancel).map(Some);
    }
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
    let installed = state::load(ctx, &value["current"])?;
    ctx.access()?;
    let files = installed.manifest.entries.len();
    let entries = installed
        .manifest
        .entries
        .into_iter()
        .filter(|entry| serviceable(&entry.path))
        .map(|entry| (entry.path.clone(), entry))
        .collect::<HashMap<_, _>>();
    Ok(Some(Snapshot {
        root,
        identity: value["current"]["identity"].as_str().unwrap().into(),
        sequence: super::number(&value["sequence"]).unwrap(),
        release_id: value["current"]["releaseId"].as_str().unwrap().into(),
        previous: !value["previous"].is_null(),
        entries,
        files,
    }))
}
pub(super) fn mount(ctx: &Context, snapshot: &Snapshot) -> Result<()> {
    ctx.access()?;
    if let Some(directory) = &ctx.directory {
        return directory.mounted(snapshot);
    }
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
