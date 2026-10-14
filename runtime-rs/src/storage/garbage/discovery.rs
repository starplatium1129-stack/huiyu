use super::*;
use crate::file_identity;
use std::fs::File;

// Directory/history discovery stays off the writer. Each call authorizes at most
// this many object/missing/staging candidates; later calls can continue cleanup.
const BATCH: usize = 128;
pub(in crate::storage) struct Discovery {
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
    workspace_id: String,
    epoch: String,
}
pub(in crate::storage) struct Candidates {
    pub(super) expired: Vec<Candidate>,
    pub(super) missing: Vec<String>,
    pub(super) staging: Vec<Staging>,
}
pub(super) struct Candidate {
    pub hash: String,
    proof: Proof,
}
pub(super) struct Proof {
    native: file_identity::Identity,
    version: media::FileIdentity,
}
impl Completion {
    pub(super) fn cancelled(&self) -> Result<()> {
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
        let completion = Completion {
            key,
            operation_id,
            cancel: c.cancel.clone(),
            root: c.root.clone(),
            root_id: file_identity::path(&schema::safe(&c.root, "")?, true)?,
            database_id: file_identity::path(&schema::safe(&c.root, "huiyu.sqlite3")?, false)?,
            owner_id: file_identity::path(&schema::safe(&c.root, ".workspace-owner.json")?, false)?,
            workspace_id: c.workspace_id.clone(),
            epoch: c.epoch.clone(),
        };
        completion.check(c)?;
        Ok(Self { completion })
    }
    pub fn run(&self) -> Result<Candidates> {
        self.completion.cancelled()?;
        self.completion.paths()?;
        let db = Connection::open_with_flags(
            schema::safe(&self.completion.root, "huiyu.sqlite3")?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch("BEGIN DEFERRED")?;
        let (workspace, epoch): (String, String) = db.query_row(
            "SELECT (SELECT value FROM meta WHERE key='workspaceId'),(SELECT value FROM meta WHERE key='writerEpoch')",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if workspace != self.completion.workspace_id || epoch != self.completion.epoch {
            return Err(conflict("WORKSPACE_IDENTITY", "Garbage source changed"));
        }
        let mut candidates = Candidates {
            expired: Vec::new(),
            missing: Vec::new(),
            staging: Vec::new(),
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
                    if candidates.expired.len() == BATCH {
                        break;
                    }
                    let hash = item?.file_name().to_string_lossy().into_owned();
                    if !media::valid_hash(&hash) || !hash.starts_with(&name) {
                        continue;
                    }
                    if db.prepare_cached("SELECT EXISTS(SELECT 1 FROM media_refs WHERE hash=?1) OR EXISTS(SELECT 1 FROM leases WHERE hash=?1)")?
                        .query_row([&hash], |row| row.get::<_, bool>(0))? { continue; }
                    let path = media::object_path(&self.completion.root, &hash)?;
                    if let Some(proof) = Proof::capture(&path)? {
                        candidates.expired.push(Candidate { hash, proof });
                    }
                }
                if candidates.expired.len() == BATCH {
                    break;
                }
            }
        }
        let mut statement = db.prepare_cached("SELECT hash FROM media_objects WHERE NOT EXISTS(SELECT 1 FROM media_refs WHERE hash=media_objects.hash) AND NOT EXISTS(SELECT 1 FROM leases WHERE hash=media_objects.hash)")?;
        let mut rows = statement.query([])?;
        while candidates.expired.len() + candidates.missing.len() < BATCH {
            let Some(row) = rows.next()? else {
                break;
            };
            self.completion.cancelled()?;
            let hash: String = row.get(0)?;
            if missing(&media::object_path(&self.completion.root, &hash)?)? {
                candidates.missing.push(hash);
            }
        }
        drop(rows);
        drop(statement);
        let remaining = BATCH - candidates.expired.len() - candidates.missing.len();
        candidates.staging = self.staging(&db, remaining)?;
        drop(db);
        self.completion.cancelled()?;
        self.completion.paths()?;
        Ok(candidates)
    }

    fn staging(&self, db: &Connection, limit: usize) -> Result<Vec<Staging>> {
        let mut selected = Vec::new();
        let directory = schema::safe(&self.completion.root, "media/staging")?;
        if limit == 0 || !directory.exists() {
            return Ok(selected);
        }
        // Retain only real directory keys. Historical task/migration rows are
        // streamed once to match those keys, never once per candidate window.
        let mut folders = Vec::new();
        for item in fs::read_dir(&directory)? {
            self.completion.cancelled()?;
            let key = item?.file_name().to_string_lossy().into_owned();
            if !media::valid_hash(&key) {
                continue;
            }
            let folder = schema::safe(&directory, &key)?;
            folders.push(Staging {
                key,
                alias_hash: None,
                native: file_identity::path(&folder, true)?,
                proof: None,
                origin: None,
            });
        }
        for candidate in match_staging(&self.completion, db, folders)? {
            self.completion.cancelled()?;
            let folder = schema::safe(&directory, &candidate.key)?;
            if missing(&folder)? || file_identity::path(&folder, true)? != candidate.native {
                continue;
            }
            let mut files = fs::read_dir(&folder)?;
            let first = files.next().transpose()?;
            if first.is_none() {
                selected.push(candidate);
            } else {
                for file in first.into_iter().map(Ok).chain(files) {
                    self.completion.cancelled()?;
                    let alias_hash = file?.file_name().to_string_lossy().into_owned();
                    if !media::valid_hash(&alias_hash) || !candidate.accepts_alias(&alias_hash) {
                        continue;
                    }
                    let path = schema::safe(&folder, &alias_hash)?;
                    if let Some(proof) = Proof::capture(&path)? {
                        selected.push(Staging {
                            key: candidate.key.clone(),
                            alias_hash: Some(alias_hash),
                            native: candidate.native.clone(),
                            proof: Some(proof),
                            origin: candidate.origin.clone(),
                        });
                    }
                    if selected.len() == limit {
                        return Ok(selected);
                    }
                }
            }
            if selected.len() == limit {
                return Ok(selected);
            }
        }
        Ok(selected)
    }
}

impl Candidate {
    pub fn current(&self, root: &std::path::Path) -> Result<Option<PathBuf>> {
        let path = media::object_path(root, &self.hash)?;
        Ok(self.proof.current(&path)?.then_some(path))
    }
}
impl Proof {
    pub(super) fn capture(path: &std::path::Path) -> Result<Option<Self>> {
        if missing(path)? {
            return Ok(None);
        }
        let stat = fs::metadata(path)?;
        if !stat.is_file() || !expired(&stat)? {
            return Ok(None);
        }
        let file = File::open(path)?;
        if !file.metadata()?.is_file() || !expired(&file.metadata()?)? {
            return Ok(None);
        }
        let native = file_identity::opened(&file)?;
        if file_identity::path(path, false)? != native {
            return Ok(None);
        }
        Ok(Some(Self {
            native,
            version: media::FileIdentity::of(&file)?,
        }))
    }
    pub(super) fn current(&self, path: &std::path::Path) -> Result<bool> {
        if missing(path)? {
            return Ok(false);
        }
        let file = File::open(path)?;
        let stat = file.metadata()?;
        Ok(stat.is_file()
            && expired(&stat)?
            && file_identity::opened(&file)? == self.native
            && media::FileIdentity::of(&file)? == self.version
            && file_identity::path(path, false)? == self.native)
    }
}
pub(super) fn missing(path: &std::path::Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}
