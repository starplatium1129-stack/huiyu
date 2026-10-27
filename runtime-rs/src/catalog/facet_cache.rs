use super::*;
use std::{
    collections::HashMap,
    io::{self, Write},
    sync::{Arc, Mutex},
};

const MAX_BYTES: usize = 1024 * 1024;

struct EncodedSize(usize);
impl Write for EncodedSize {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Generation {
    database: PathBuf,
    file: crate::file_identity::Identity,
    pub(super) version: i64,
}

#[derive(Default)]
struct Entries {
    generation: Option<Generation>,
    kinds: HashMap<String, (Arc<Value>, i64)>,
    bytes: usize,
}

/// Owned by AppState, not the per-request connection. Only one database revision
/// and the six supported query kinds are retained, with a 1 MiB encoded budget.
#[derive(Default)]
pub(crate) struct FacetCache(Mutex<Entries>);

impl FacetCache {
    pub(super) fn select(
        &self,
        catalog: &Catalog,
        kind: &str,
    ) -> Result<(Generation, Option<(Arc<Value>, i64)>)> {
        let mut entries = self.0.lock().unwrap();
        // The first SELECT of the deferred transaction pins the same revision
        // used by count, page and facets. Serialize generation selection so a
        // late reader cannot select an older snapshot after a newer one.
        let generation = Generation {
            database: catalog.options.database.canonicalize()?,
            file: crate::file_identity::path(&catalog.options.database, false)?,
            version: catalog.version()?,
        };
        if entries.generation.as_ref() != Some(&generation) {
            entries.kinds.clear();
            entries.bytes = 0;
            entries.generation = Some(generation.clone());
        }
        let value = entries.kinds.get(kind).cloned();
        drop(entries);
        Ok((generation, value))
    }

    pub(super) fn publish(
        &self,
        generation: Generation,
        kind: &str,
        value: Arc<Value>,
        total: i64,
    ) -> Result<()> {
        let mut size = EncodedSize(0);
        serde_json::to_writer(&mut size, &(value.as_ref(), total))?;
        let bytes = size.0;
        let mut entries = self.0.lock().unwrap();
        // Misses are computed outside the mutex. Never publish a late result
        // into another revision, or keep an unbounded facet set.
        if entries.generation.as_ref() != Some(&generation)
            || entries.kinds.contains_key(kind)
            || bytes > MAX_BYTES
        {
            return Ok(());
        }
        if entries.bytes + bytes > MAX_BYTES {
            entries.kinds.clear();
            entries.bytes = 0;
        }
        entries.bytes += bytes;
        entries.kinds.insert(kind.to_owned(), (value, total));
        Ok(())
    }
}
