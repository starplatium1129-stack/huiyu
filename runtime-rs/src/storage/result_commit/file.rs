use super::*;
use std::{fs::File, path::Path};

pub(in crate::storage) struct Verified {
    pub(super) path: PathBuf,
    file: File,
    native: file_identity::Identity,
    version: media::FileIdentity,
}
impl Verified {
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

pub(super) fn source(pending: &Pending) -> Result<PathBuf> {
    let path = media::object_path(&pending.identity.root, pending.hash())?;
    if path.try_exists()? {
        return Ok(path);
    }
    media::staging_path(
        &pending.identity.root,
        pending.key(),
        string(&pending.output.media, "alias")?,
    )
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
    #[cfg(test)]
    tasks::media_tests::commit_validation::pause(path, "before-hash");
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
    };
    verified.check(&identity.root)?;
    identity.cancelled()?;
    #[cfg(test)]
    tasks::media_tests::commit_validation::pause(path, "verified");
    Ok(verified)
}
