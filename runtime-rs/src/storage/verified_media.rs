use super::*;
use crate::file_identity;
use std::{fs::File, path::Path};

#[derive(Clone)]
pub(super) struct Identity {
    pub(super) root: PathBuf,
    workspace_id: String,
    epoch: String,
    root_id: file_identity::Identity,
    database_id: file_identity::Identity,
    owner_id: file_identity::Identity,
    pub(super) cancel: Arc<AtomicBool>,
}
impl Identity {
    pub(super) fn new(c: &Context) -> Result<Self> {
        Ok(Self {
            root: c.root.clone(),
            workspace_id: c.workspace_id.clone(),
            epoch: c.epoch.clone(),
            root_id: file_identity::path(&schema::safe(&c.root, "")?, true)?,
            database_id: file_identity::path(&schema::safe(&c.root, "huiyu.sqlite3")?, false)?,
            owner_id: file_identity::path(&schema::safe(&c.root, ".workspace-owner.json")?, false)?,
            cancel: c.cancel.clone(),
        })
    }
    pub(super) fn cancelled(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(ApiError::new(
                499,
                "CANCELLED",
                "Media verification was cancelled",
            ));
        }
        Ok(())
    }
    pub(super) fn check(&self, c: &Context) -> Result<()> {
        self.cancelled()?;
        c.writer()?;
        c.owner.check()?;
        if self.root != c.root || self.workspace_id != c.workspace_id || self.epoch != c.epoch {
            return Err(conflict(
                "WORKSPACE_IDENTITY",
                "Workspace changed during media verification",
            ));
        }
        self.check_paths()
    }
    pub(super) fn check_paths(&self) -> Result<()> {
        self.cancelled()?;
        let root = file_identity::path(&schema::safe(&self.root, "")?, true)?;
        if root.dev != self.root_id.dev
            || root.ino != self.root_id.ino
            || file_identity::path(&schema::safe(&self.root, "huiyu.sqlite3")?, false)?
                != self.database_id
            || file_identity::path(&schema::safe(&self.root, ".workspace-owner.json")?, false)?
                != self.owner_id
        {
            return Err(conflict(
                "WORKSPACE_IDENTITY",
                "Workspace changed during media verification",
            ));
        }
        Ok(())
    }
}

pub(super) struct Verified {
    pub(super) path: PathBuf,
    file: File,
    native: file_identity::Identity,
    version: media::FileIdentity,
    bytes: u64,
    hash: String,
    mime: Option<String>,
}
impl Verified {
    pub(super) fn matches(&self, path: &Path, media: &Value) -> bool {
        self.path == path
            && Some(self.bytes) == media["bytes"].as_u64()
            && Some(self.hash.as_str()) == media["sha256"].as_str()
            && self.mime.as_deref() == media["mime"].as_str()
    }
    pub(super) fn check(&self, root: &Path) -> Result<()> {
        let relative = self
            .path
            .strip_prefix(root)
            .map_err(|_| invalid("Media path escapes workspace"))?;
        schema::safe(root, relative)?;
        let current = File::open(&self.path)?;
        if file_identity::opened(&current)? != self.native
            || file_identity::opened(&self.file)? != self.native
            || media::FileIdentity::of(&current)? != self.version
            || media::FileIdentity::of(&self.file)? != self.version
        {
            return Err(conflict(
                "MEDIA_INVALID",
                "Media identity or content version changed during verification",
            ));
        }
        Ok(())
    }
}

pub(super) fn verify(identity: &Identity, path: &Path, media: &Value) -> Result<Verified> {
    identity.cancelled()?;
    schema::safe(
        &identity.root,
        path.strip_prefix(&identity.root)
            .map_err(|_| invalid("Media path escapes workspace"))?,
    )?;
    let mut file = File::open(path)?;
    let native = file_identity::opened(&file)?;
    let version = media::FileIdentity::of(&file)?;
    let (bytes, hash, mime) = media::hash_opened(&mut file, || identity.cancelled())?;
    if bytes != media["bytes"].as_u64().unwrap()
        || hash != string(media, "sha256")?
        || mime.as_deref() != media["mime"].as_str()
    {
        return Err(conflict(
            "MEDIA_INVALID",
            "Media digest or actual file type does not match",
        ));
    }
    let verified = Verified {
        path: path.into(),
        file,
        native,
        version,
        bytes,
        hash,
        mime,
    };
    verified.check(&identity.root)?;
    identity.cancelled()?;
    Ok(verified)
}
