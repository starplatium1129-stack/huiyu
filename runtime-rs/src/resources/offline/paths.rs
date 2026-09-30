use super::{Error, Options, Result, Value, fs, json};
use crate::config::Config;
use std::path::{Path, PathBuf};

pub(super) struct Paths {
    pub user: PathBuf,
    pub showcase: PathBuf,
    pub policy: PathBuf,
    pub pending: PathBuf,
}
impl Paths {
    pub fn new(options: &Options) -> Result<Self> {
        fs::safe(&options.app, false, false)?;
        fs::safe(&options.package, false, false)?;
        fs::safe(&options.runtime, true, false)?;
        if !options.app.is_dir() || !options.package.is_dir() {
            return Err(Error::new(
                "UNSAFE_PATH",
                "Application and package roots must be directories",
            ));
        }
        let parent = options
            .runtime
            .parent()
            .filter(|path| path.parent().is_some())
            .ok_or_else(|| {
                Error::new(
                    "PROTECTED_ROOT",
                    "Runtime needs a user-owned parent directory",
                )
            })?;
        let value = Self {
            user: parent.join("offline-resources"),
            showcase: parent.join("showcase"),
            policy: options.runtime.join("offline-resource-config.json"),
            pending: options.runtime.join("offline-install-pending.json"),
        };
        for target in [&value.user, &value.showcase, &options.runtime] {
            fs::safe(target, true, false)?;
            for protected in [
                &options.app,
                &options.package,
                &options.app.join("assets"),
                &options.runtime.join("outputs"),
            ] {
                if fs::within(protected, target)? || fs::within(target, protected)? {
                    // outputs are deliberately inside runtime, but no resource store may contain them.
                    if target == &options.runtime && protected == &options.runtime.join("outputs") {
                        continue;
                    }
                    return Err(Error::new(
                        "PROTECTED_ROOT",
                        "Offline destination overlaps application, source or outputs",
                    ));
                }
            }
        }
        Ok(value)
    }
    pub fn pointer(&self) -> Result<Value> {
        pointer(&self.showcase)
    }
    pub fn current_root(&self, pointer: &Value) -> Result<Option<PathBuf>> {
        pointer_root(&self.showcase, &pointer["current"])
    }
}
fn reference(value: &Value) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    let path = value["path"].as_str().unwrap_or("");
    if !path
        .strip_prefix("editions/")
        .is_some_and(|tail| uuid::Uuid::parse_str(tail).is_ok() && tail.len() == 36)
        || !super::super::hash(value["releaseSha256"].as_str().unwrap_or(""))
        || !super::super::hash(value["contentIdentity"].as_str().unwrap_or(""))
    {
        return Err(Error::new(
            "STATE_INVALID",
            "Invalid showcase edition reference",
        ));
    }
    fs::relative(path)
}
pub(super) fn pointer(root: &Path) -> Result<Value> {
    let value = fs::json(&root.join("active.json"), true, false)?
        .unwrap_or_else(|| json!({"schemaVersion":1,"kind":"huiyu-showcase-current","current":null,"previous":null}));
    validate_pointer(&value)?;
    Ok(value)
}
pub(super) fn validate_pointer(value: &Value) -> Result<()> {
    if value["schemaVersion"] != 1
        || value["kind"] != "huiyu-showcase-current"
        || value.get("current").is_none()
        || value.get("previous").is_none()
    {
        return Err(Error::new("STATE_INVALID", "Invalid showcase pointer"));
    }
    reference(&value["current"])?;
    reference(&value["previous"])?;
    Ok(())
}
pub(super) fn pointer_root(root: &Path, value: &Value) -> Result<Option<PathBuf>> {
    reference(value)?;
    if value.is_null() {
        return Ok(None);
    }
    let path = fs::child(root, value["path"].as_str().unwrap())?;
    fs::safe(&path, false, false)?;
    fs::safe(&path.join("manifest.json"), false, false)?;
    Ok(Some(path))
}
fn edition(root: &Path) -> Option<PathBuf> {
    fs::safe(root, true, false).ok()??;
    if fs::safe(&root.join("manifest.json"), true, false)
        .ok()?
        .is_some()
    {
        return Some(root.into());
    }
    let mut editions = Vec::new();
    for item in std::fs::read_dir(root).ok()?.flatten() {
        if !item.file_name().to_string_lossy().starts_with('.')
            && item.file_type().ok()?.is_dir()
            && fs::safe(&item.path().join("manifest.json"), true, false)
                .ok()
                .flatten()
                .is_some()
        {
            editions.push(item.path());
        }
    }
    let locale: icu_locale::Locale = "zh-CN".parse().ok()?;
    let collator = icu_collator::Collator::try_new(
        locale.into(),
        icu_collator::options::CollatorOptions::default(),
    )
    .ok()?;
    editions.sort_by(|a, b| {
        collator.compare(
            &b.file_name().unwrap().to_string_lossy(),
            &a.file_name().unwrap().to_string_lossy(),
        )
    });
    editions.into_iter().next()
}
/// Maintenance and remote projection select exactly the same edition at startup.
/// A broken managed pointer never falls back to an unrelated source directory.
pub(crate) fn showcase_root(config: &Config) -> Option<PathBuf> {
    let saved = fs::json(&config.runtime_root.join("config.json"), true, false)
        .ok()
        .flatten()
        .unwrap_or(Value::Null);
    let explicit = std::env::var_os("SCENE_SHOWCASE_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            saved["sceneShowcaseDir"]
                .as_str()
                .filter(|path| !path.trim().is_empty())
                .map(PathBuf::from)
        });
    if let Some(path) = explicit
        .and_then(|path| fs::absolute(&path).ok())
        .and_then(|path| edition(&path))
    {
        return Some(path);
    }
    let managed = config.runtime_root.parent()?.join("showcase");
    if fs::safe(&managed.join("active.json"), true, false)
        .ok()?
        .is_some()
    {
        return pointer(&managed)
            .and_then(|value| pointer_root(&managed, &value["current"]))
            .ok()
            .flatten();
    }
    [
        config.ai_workspace_root.join("SceneShowcase"),
        config
            .app_root
            .parent()
            .unwrap_or(&config.app_root)
            .join("AI/SceneShowcase"),
    ]
    .iter()
    .find_map(|root| edition(root))
}
