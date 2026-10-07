use super::*;
use std::{collections::HashMap, sync::Mutex};

const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Generation {
    database: PathBuf,
    file: crate::file_identity::Identity,
    pub(super) version: i64,
}

#[derive(Default)]
struct Entries {
    generation: Option<Generation>,
    kinds: HashMap<String, Value>,
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
    ) -> Result<(Generation, Option<Value>)> {
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
        Ok((generation, entries.kinds.get(kind).cloned()))
    }

    pub(super) fn publish(&self, generation: Generation, kind: &str, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(value)?.len();
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
        entries.kinds.insert(kind.to_owned(), value.clone());
        Ok(())
    }
}
