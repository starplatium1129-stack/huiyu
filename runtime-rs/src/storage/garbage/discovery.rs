use super::*;
use crate::file_identity;
use std::fs::File;

// Only filesystem discovery runs outside the writer. These identities never
// authorize deletion; finish rechecks live refs, leases and owner in its transaction.
pub(in crate::storage) struct Discovery {
    hashes: Vec<String>,
    pub completion: Completion,
}
pub(in crate::storage) struct Completion {
    pub key: String,
    pub operation_id: Value,
    pub cancel: Arc<AtomicBool>,
    root: PathBuf,
    root_id: file_identity::Identity,
    database_id: file_identity::Identity,
    owner_id: file_identity::Identity,
}
pub(in crate::storage) struct Candidates {
    pub(super) expired: Vec<Candidate>,
    pub(super) missing: Vec<String>,
}
pub(super) struct Candidate {
    pub hash: String,
    native: file_identity::Identity,
    version: media::FileIdentity,
}
impl Completion {
    fn cancelled(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(ApiError::new(
                499,
                "CANCELLED",
                "Workspace garbage discovery was cancelled",
            ));
        }
        Ok(())
    }
    fn paths(&self) -> Result<()> {
        schema::safe(&self.root, "")?;
        let root = file_identity::path(&self.root, true)?;
        // A child directory may legitimately change nlink while discovery runs.
        if root.dev != self.root_id.dev
            || root.ino != self.root_id.ino
            || file_identity::path(&schema::safe(&self.root, "huiyu.sqlite3")?, false)?
                != self.database_id
            || file_identity::path(&schema::safe(&self.root, ".workspace-owner.json")?, false)?
                != self.owner_id
        {
            return Err(conflict(
                "WORKSPACE_IDENTITY",
                "Workspace paths changed during garbage discovery",
            ));
        }
        Ok(())
    }
    pub fn check(&self, c: &Context) -> Result<()> {
        self.cancelled()?;
        if self.root != c.root {
            return Err(conflict("WORKSPACE_IDENTITY", "Workspace root changed"));
        }
        c.writer()?;
        c.owner.check()?;
        self.paths()
    }
}
impl Discovery {
    pub fn new(c: &Context, key: String, operation_id: Value) -> Result<Self> {
        let mut statement = c.db.prepare_cached("SELECT hash FROM media_objects")?;
        let mut rows = statement.query([])?;
        let mut hashes = Vec::new();
        while let Some(row) = rows.next()? {
            c.check_cancel()?;
            hashes.push(row.get(0)?);
        }
        let completion = Completion {
            key,
            operation_id,
            cancel: c.cancel.clone(),
            root: c.root.clone(),
            root_id: file_identity::path(&schema::safe(&c.root, "")?, true)?,
            database_id: file_identity::path(&schema::safe(&c.root, "huiyu.sqlite3")?, false)?,
            owner_id: file_identity::path(&schema::safe(&c.root, ".workspace-owner.json")?, false)?,
        };
        completion.check(c)?;
        Ok(Self { hashes, completion })
    }
    pub fn run(&self) -> Result<Candidates> {
        self.completion.cancelled()?;
        self.completion.paths()?;
        let mut candidates = Candidates {
            expired: Vec::new(),
            missing: Vec::new(),
        };
        let directory = schema::safe(&self.completion.root, "media/objects")?;
        if directory.exists() {
            for prefix in fs::read_dir(&directory)? {
                self.completion.cancelled()?;
                let prefix = prefix?;
                let name = prefix.file_name().to_string_lossy().into_owned();
                if name.len() != 2
                    || !name
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                {
                    continue;
                }
                let folder = schema::safe(&directory, &name)?;
                if !folder.is_dir() {
                    continue;
                }
                for item in fs::read_dir(folder)? {
                    self.completion.cancelled()?;
                    let hash = item?.file_name().to_string_lossy().into_owned();
                    if !media::valid_hash(&hash) || !hash.starts_with(&name) {
                        continue;
                    }
                    let path = media::object_path(&self.completion.root, &hash)?;
                    if missing(&path)? {
                        continue;
                    }
                    let stat = fs::metadata(&path)?;
                    if !stat.is_file() || !expired(&stat)? {
                        continue;
                    }
                    let file = File::open(&path)?;
                    if !file.metadata()?.is_file() || !expired(&file.metadata()?)? {
                        continue;
                    }
                    let native = file_identity::opened(&file)?;
                    let version = media::FileIdentity::of(&file)?;
                    if file_identity::path(&path, false)? != native {
                        continue;
                    }
                    candidates.expired.push(Candidate {
                        hash,
                        native,
                        version,
                    });
                }
            }
        }
        for hash in &self.hashes {
            self.completion.cancelled()?;
            if missing(&media::object_path(&self.completion.root, hash)?)? {
                candidates.missing.push(hash.clone());
            }
        }
        self.completion.cancelled()?;
        self.completion.paths()?;
        Ok(candidates)
    }
}
impl Candidate {
    pub fn current(&self, root: &std::path::Path) -> Result<Option<PathBuf>> {
        let path = media::object_path(root, &self.hash)?;
        if missing(&path)? {
            return Ok(None);
        }
        let file = File::open(&path)?;
        let stat = file.metadata()?;
        if !stat.is_file()
            || !expired(&stat)?
            || file_identity::opened(&file)? != self.native
            || media::FileIdentity::of(&file)? != self.version
            || file_identity::path(&path, false)? != self.native
        {
            return Ok(None);
        }
        Ok(Some(path))
    }
}
pub(super) fn missing(path: &std::path::Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}
