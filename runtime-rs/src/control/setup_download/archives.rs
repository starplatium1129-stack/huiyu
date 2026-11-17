use super::*;
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::Path,
};

struct VerifiedArchive {
    sha256: String,
    identity: file_identity::Identity,
    version: Version,
}

// A verification record belongs to one path, file identity and version within
// this gateway process. Opening the path for reading prevents writes on Windows.
#[derive(Default)]
pub(in crate::control) struct VerifiedArchives(Mutex<HashMap<String, VerifiedArchive>>);

impl VerifiedArchives {
    pub(in crate::control) fn record(
        &self,
        path: PathBuf,
        sha256: String,
        identity: file_identity::Identity,
        file: &File,
    ) {
        if let (Ok(key), Ok(version)) = (crate::file_paths::key(&path), Version::of(file)) {
            self.0.lock().unwrap().insert(
                key,
                VerifiedArchive {
                    sha256,
                    identity,
                    version,
                },
            );
        }
    }

    pub(in crate::control) fn hold(
        &self,
        path: &Path,
        root: &Path,
        sha256: &str,
    ) -> std::io::Result<(File, bool)> {
        let file = OpenOptions::new().read(true).share_mode(0x1).open(path)?; // FILE_SHARE_READ
        let identity = file_identity::opened(&file)?;
        if !same_file_at(path, &identity) || !path.canonicalize()?.starts_with(root.canonicalize()?)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Archive path changed",
            ));
        }
        let version = Version::of(&file);
        let key = crate::file_paths::key(path)?;
        let checked = self.0.lock().unwrap().get(&key).is_some_and(|receipt| {
            receipt.sha256 == sha256
                && receipt.identity == identity
                && version
                    .as_ref()
                    .is_ok_and(|current| *current == receipt.version)
        });
        Ok((file, checked))
    }
}
