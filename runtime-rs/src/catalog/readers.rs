use super::*;
use crate::file_identity::{self, Identity};
use std::{
    fs::File,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

const READER_IDLE_CLOSE: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(crate) struct Reader(Arc<Mutex<ReaderSlot>>);

#[derive(Default)]
struct ReaderSlot {
    open: Option<OpenReader>,
    reaper_scheduled: bool,
}

struct OpenReader {
    catalog: Catalog,
    identity: Identity,
    modified: Option<SystemTime>,
    schema_version: i64,
    data_version: i64,
    generation: uuid::Uuid,
    last_used: Instant,
}

impl Reader {
    pub(crate) fn with<T>(
        &self,
        options: Options,
        read: impl FnOnce(&Catalog, &Identity, (uuid::Uuid, i64)) -> Result<T>,
    ) -> Result<T> {
        let mut slot = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (identity, modified) = match file_stamp(&options.database) {
            Ok(stamp) => stamp,
            Err(error) => {
                slot.open = None;
                return Err(error);
            }
        };
        let existing = slot.open.take();
        let mut reader = match existing {
            Some(reader)
                if reader.identity == identity
                    && reader.catalog.options.database == options.database =>
            {
                reader
            }
            stale => {
                // Explicitly drop any previous SQLite handle before opening/repairing.
                drop(stale);
                OpenReader::open(options, &identity)?
            }
        };
        let data_version = pragma(&reader.catalog, "data_version")?;
        if reader.modified != modified || reader.data_version != data_version {
            let schema_version = pragma(&reader.catalog, "schema_version")?;
            if reader.schema_version != schema_version || !schema_policy_current(&reader.catalog)? {
                // Drop the old SQLite handle before any additive repair.
                let options = reader.catalog.options.clone();
                drop(reader);
                reader = OpenReader::open(options, &identity)?;
            } else {
                reader.modified = modified;
                reader.data_version = data_version;
            }
        }
        let result = read(
            &reader.catalog,
            &reader.identity,
            (reader.generation, reader.data_version),
        );
        reader.last_used = Instant::now();
        slot.open = Some(reader);
        if !slot.reaper_scheduled
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            slot.reaper_scheduled = true;
            let shared = self.0.clone();
            handle.spawn(async move {
                loop {
                    tokio::time::sleep(READER_IDLE_CLOSE).await;
                    let mut slot = shared
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let expired = slot
                        .open
                        .as_ref()
                        .is_none_or(|reader| reader.last_used.elapsed() >= READER_IDLE_CLOSE);
                    if expired {
                        slot.open = None;
                        slot.reaper_scheduled = false;
                        break;
                    }
                }
            });
        }
        result
    }
}

impl OpenReader {
    fn open(options: Options, expected: &Identity) -> Result<Self> {
        // Retain the one-time migration and identity-marker contract of older
        // catalogs. The reused serving connection itself is read-only.
        drop(Catalog::open_existing(options.clone())?);
        let catalog = Catalog::open_readonly(options)?;
        catalog.connection.set_prepared_statement_cache_capacity(48);
        // Keep mmap disabled on Windows so external catalog replacement/restore never hits ERROR_USER_MAPPED_FILE.
        catalog.connection.execute_batch(
            "PRAGMA query_only=ON; PRAGMA cache_size=-8192;
             PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY;",
        )?;
        let (identity, modified) = file_stamp(&catalog.options.database)?;
        if &identity != expected {
            return Err(ApiError::new(
                503,
                "CATALOG_REPLACED",
                "内容库刚刚切换，请重试",
            ));
        }
        Ok(Self {
            schema_version: pragma(&catalog, "schema_version")?,
            data_version: pragma(&catalog, "data_version")?,
            catalog,
            identity,
            modified,
            generation: uuid::Uuid::new_v4(),
            last_used: Instant::now(),
        })
    }
}

fn pragma(catalog: &Catalog, name: &str) -> Result<i64> {
    Ok(catalog
        .connection
        .pragma_query_value(None, name, |row| row.get(0))?)
}

fn schema_policy_current(catalog: &Catalog) -> Result<bool> {
    Ok(catalog.connection.query_row(
        "SELECT COUNT(*)=2 FROM catalog_meta
         WHERE (key='schema' AND value='1') OR (key='seedPolicy' AND value='2')",
        [],
        |row| row.get(0),
    )?)
}

fn file_stamp(path: &Path) -> Result<(Identity, Option<SystemTime>)> {
    let file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::new(
                503,
                "CATALOG_MISSING",
                "已启用的内容库缺失，请恢复内容快照或备份",
            )
        } else {
            error.into()
        }
    })?;
    let metadata = file.metadata()?;
    Ok((file_identity::opened(&file)?, metadata.modified().ok()))
}
