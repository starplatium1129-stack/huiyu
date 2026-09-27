use super::{Error, PathBuf, Result, Value, fs, json, policy};
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub(super) struct Context {
    pub store: PathBuf,
    pub policy: Value,
    pub file: PathBuf,
    pub bytes: Arc<Vec<u8>>,
    pub shutdown: CancellationToken,
}
#[derive(Clone)]
pub(super) struct Configuration {
    pub ctx: Context,
    pub releases: Vec<Value>,
}
pub(super) fn cancelled(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(Error::new(
            "CANCELLED",
            "Operation cancelled; verified files retained",
        ))
    } else {
        Ok(())
    }
}
impl Context {
    pub fn unchanged(&self) -> bool {
        fs::bytes(&self.file, fs::MAX_JSON, false).is_ok_and(|bytes| bytes == *self.bytes)
    }
    pub fn access(&self) -> Result<()> {
        if self.shutdown.is_cancelled() || !self.unchanged() {
            Err(Error::new(
                "ACCESS_DENIED",
                "Configuration authorization changed",
            ))
        } else {
            Ok(())
        }
    }
    pub fn initialize(&self) -> Result<()> {
        self.access()?;
        if let Some(stat) = fs::safe(&self.store, true, false)? {
            if !stat.is_dir() {
                return Err(Error::new(
                    "UNOWNED_ROOT",
                    "Resource store is not a directory",
                ));
            }
        } else {
            fs::ensure(&self.store)?;
        }
        let marker = self.store.join("store.json");
        let expected = json!({"schemaVersion":1,"kind":"aics-resource-library"});
        match fs::json(&marker, true, false)? {
            Some(value) if !super::equal(&value, &expected) => {
                return Err(Error::new(
                    "UNOWNED_ROOT",
                    "Resource ownership marker invalid",
                ));
            }
            Some(_) => {}
            None => {
                for entry in std::fs::read_dir(&self.store)? {
                    let name = entry?.file_name().to_string_lossy().into_owned();
                    if !name
                        .strip_prefix(".store.json.")
                        .and_then(|name| name.strip_suffix(".tmp"))
                        .is_some_and(|token| {
                            !token.is_empty()
                                && token
                                    .bytes()
                                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
                        })
                    {
                        return Err(Error::new(
                            "UNOWNED_ROOT",
                            "Refusing unowned resource directory",
                        ));
                    }
                }
                fs::write_json(&marker, &expected)?;
            }
        }
        fs::ensure(&self.store.join("locks"))
    }
}
pub(super) fn load(
    gateway: &crate::config::Config,
    path: &Path,
    shutdown: CancellationToken,
) -> Result<Configuration> {
    if !path.is_absolute() {
        return Err(Error::new(
            "CONFIG_REQUIRED",
            "Resource configuration must be absolute",
        ));
    }
    let bytes = fs::bytes(path, fs::MAX_JSON, false)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::new("CONFIG_REQUIRED", "Invalid resource configuration"))?;
    if !value["policy"].is_object()
        || !value["policy"]["sources"].is_object()
        || !value["policy"]["releases"].is_object()
    {
        return Err(Error::new("CONFIG_REQUIRED", "Explicit policy required"));
    }
    let protected = value["protectedRoots"]
        .as_array()
        .ok_or_else(|| Error::new("CONFIG_REQUIRED", "Explicit protectedRoots required"))?;
    let mut roots = Vec::new();
    for root in protected {
        roots.push(PathBuf::from(root.as_str().ok_or_else(|| {
            Error::new("CONFIG_REQUIRED", "Invalid protected root")
        })?));
    }
    roots.extend([
        gateway.app_root.clone(),
        gateway.assets_root(),
        gateway.runtime_root.join("outputs"),
    ]);
    if let Some(reference) = crate::reference::reference_root(&gateway.app_root) {
        roots.push(reference);
    }
    let user_root = PathBuf::from(
        value["userDataRoot"]
            .as_str()
            .ok_or_else(|| Error::new("CONFIG_REQUIRED", "Absolute userDataRoot required"))?,
    );
    if !user_root.is_absolute() {
        return Err(Error::new(
            "CONFIG_REQUIRED",
            "Absolute userDataRoot required",
        ));
    }
    let user_root = fs::absolute(&user_root)?;
    let store = user_root.join("resource-library-v1");
    for root in roots {
        if !root.is_absolute() {
            return Err(Error::new(
                "CONFIG_REQUIRED",
                "Protected roots must be absolute",
            ));
        }
        if fs::safe(&root, true, false)?.is_some_and(|stat| !stat.is_dir()) {
            return Err(Error::new(
                "CONFIG_REQUIRED",
                "Protected root is not a directory",
            ));
        }
        if fs::within(&root, &store)? || fs::within(&store, &root)? {
            return Err(Error::new(
                "PROTECTED_ROOT",
                "Resource store overlaps protected root",
            ));
        }
    }
    if !fs::safe(&user_root, false, false)?.unwrap().is_dir() {
        return Err(Error::new("CONFIG_REQUIRED", "userDataRoot must exist"));
    }
    let ctx = Context {
        store,
        policy: value["policy"].clone(),
        file: path.into(),
        bytes: Arc::new(bytes),
        shutdown,
    };
    let mut releases = Vec::new();
    for id in ctx.policy["releases"].as_object().unwrap().keys() {
        if let Ok(release) = policy::release(&ctx, id) {
            if release["source"]["kind"] == "http"
                && policy::source_url(&release, "manifest.json").is_err()
            {
                continue;
            }
            let label = release["label"]
                .as_str()
                .map(|s| String::from_utf16_lossy(&s.encode_utf16().take(100).collect::<Vec<_>>()))
                .unwrap_or_else(|| id.clone());
            releases.push(json!({"id":id,"label":label,"kind":release["kind"],"source":release["source"]["kind"],"identity":release["targetIdentity"]}));
        }
    }
    Ok(Configuration { ctx, releases })
}
