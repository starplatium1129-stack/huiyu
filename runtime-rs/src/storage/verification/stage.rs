use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

const PREFIX: &str = "internal-task-";
const RANDOM_CHARS: usize = 6;

// Only called while opening the exclusively owned workspace, before admission.
// Live verifiers retain the owner sender; explicit close drains their permits.
// These private copies have no durable task reference until install moves them.
pub(in crate::storage) fn recover_staging(c: &super::super::Context) -> Result<()> {
    use crate::file_identity;
    use std::fs;

    let identity = super::super::verified_media::Identity::new(c)?;
    identity.check(c)?;
    let directory = schema::safe(&c.root, "media/staging")?;
    if !directory.try_exists()? {
        return Ok(());
    }
    let directory_id = file_identity::path(&directory, true)?;
    let mut removed = false;
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(suffix) = name.to_str().and_then(|name| name.strip_prefix(PREFIX)) else {
            continue;
        };
        if suffix.len() != RANDOM_CHARS
            || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            || !entry.file_type()?.is_file()
        {
            continue;
        }
        let path = schema::safe(&directory, &name)?;
        let file = File::open(&path)?;
        let native = file_identity::opened(&file)?;
        if !file.metadata()?.is_file() || native.links != 1 {
            continue;
        }
        let version = media::FileIdentity::of(&file)?;
        identity.check(c)?;
        schema::safe(&c.root, "media/staging")?;
        schema::safe(&directory, &name)?;
        if file_identity::path(&directory, true)? != directory_id
            || file_identity::path(&path, false)? != native
            || file_identity::opened(&file)? != native
            || media::FileIdentity::of(&file)? != version
        {
            return Err(super::super::conflict(
                "MEDIA_INVALID",
                "Private task snapshot changed during startup recovery",
            ));
        }
        fs::remove_file(path)?;
        removed = true;
    }
    identity.check(c)?;
    if removed {
        schema::safe(&c.root, "media/staging")?;
        if file_identity::path(&directory, true)? != directory_id {
            return Err(super::super::conflict(
                "MEDIA_INVALID",
                "Task staging directory changed during startup recovery",
            ));
        }
        schema::sync_dir(&directory)?;
    }
    Ok(())
}

pub(crate) struct Staged {
    file: tempfile::NamedTempFile,
    native: crate::file_identity::Identity,
    version: media::FileIdentity,
}
impl Staged {
    pub(in crate::storage) fn install(
        self,
        root: &std::path::Path,
        path: &std::path::Path,
    ) -> Result<()> {
        schema::safe(
            root,
            self.file
                .path()
                .strip_prefix(root)
                .map_err(|_| invalid("Staged media escaped workspace"))?,
        )?;
        if crate::file_identity::opened(self.file.as_file())? != self.native
            || crate::file_identity::path(self.file.path(), false)? != self.native
            || media::FileIdentity::of(self.file.as_file())? != self.version
        {
            return Err(ApiError::new(
                409,
                "MEDIA_INVALID",
                "Private task snapshot changed",
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| invalid("Media path escaped workspace"))?;
        schema::safe(root, relative)?;
        std::fs::create_dir_all(path.parent().unwrap())?;
        schema::safe(root, relative)?;
        // This is the authorized task's uncommitted staging path. Replacing a
        // recovered partial copy is atomic; existing final objects are never replaced.
        self.file
            .persist(path)
            .map_err(|e| ApiError::from(e.error))?;
        schema::sync_dir(path.parent().unwrap())?;
        Ok(())
    }
}
impl Verifier {
    pub(in crate::storage) async fn stage(
        self: &Arc<Self>,
        root: Arc<PathBuf>,
        path: PathBuf,
        bytes: u64,
        owner: tokio::sync::mpsc::Sender<super::super::Work>,
    ) -> Result<(Staged, String)> {
        let cancelled = self.closed.child_token();
        let _cancel = cancelled.clone().drop_guard();
        let permit = tokio::select! { biased;
            _ = cancelled.cancelled() => return Err(unavailable()),
            permit = self.workers.clone().acquire_owned() => permit.map_err(|_|unavailable())?,
        };
        tokio::task::spawn_blocking(move || {
            let (_permit, _owner) = (permit, owner);
            check(&cancelled)?;
            let directory = schema::safe(&root, "media/staging")?;
            std::fs::create_dir_all(&directory)?;
            schema::safe(&root, "media/staging")?;
            let mut staged = tempfile::Builder::new()
                .prefix(PREFIX)
                .rand_bytes(RANDOM_CHARS)
                .tempfile_in(directory)?;
            let mut input = File::open(path)?;
            if !input.metadata()?.is_file() || input.metadata()?.len() != bytes {
                return Err(ApiError::new(
                    409,
                    "MEDIA_INVALID",
                    "Task file length changed",
                ));
            }
            let source_native = crate::file_identity::opened(&input)?;
            let source_version = media::FileIdentity::of(&input)?;
            let mut left = bytes;
            let mut buffer = vec![0; 1024 * 1024];
            let mut digest = Sha256::new();
            while left > 0 {
                check(&cancelled)?;
                let length = left.min(buffer.len() as u64) as usize;
                input.read_exact(&mut buffer[..length])?;
                staged.write_all(&buffer[..length])?;
                digest.update(&buffer[..length]);
                left -= length as u64;
            }
            if input.read(&mut [0; 1])? != 0 {
                return Err(ApiError::new(
                    409,
                    "MEDIA_INVALID",
                    "Task file grew during copy",
                ));
            }
            if crate::file_identity::opened(&input)? != source_native
                || media::FileIdentity::of(&input)? != source_version
            {
                return Err(ApiError::new(
                    409,
                    "MEDIA_INVALID",
                    "Task file changed during copy",
                ));
            }
            staged.as_file().sync_all()?;
            check(&cancelled)?;
            let native = crate::file_identity::opened(staged.as_file())?;
            let version = media::FileIdentity::of(staged.as_file())?;
            Ok((
                Staged {
                    file: staged,
                    native,
                    version,
                },
                hex::encode(digest.finalize()),
            ))
        })
        .await
        .map_err(|_| unavailable())?
    }
}
