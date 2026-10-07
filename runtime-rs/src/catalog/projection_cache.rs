use super::*;
use axum::body::Bytes;
use std::{collections::HashMap, sync::Mutex};

const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
struct Encoded {
    identity: Option<(crate::file_identity::Identity, i64)>,
    entries: HashMap<String, Bytes>,
    bytes: usize,
}
impl Encoded {
    fn select(&mut self, identity: &(crate::file_identity::Identity, i64)) {
        if self.identity.as_ref() != Some(identity) {
            self.entries.clear();
            self.bytes = 0;
            self.identity = Some(identity.clone());
        }
    }
    fn publish(
        &mut self,
        identity: &(crate::file_identity::Identity, i64),
        name: &str,
        bytes: &Bytes,
    ) {
        // An older request can finish encoding after a newer commit has already
        // populated the cache. It may answer its own reader, never rewind the cache.
        if self.identity.as_ref() != Some(identity) || bytes.len() > MAX_BYTES {
            return;
        }
        if let Some(previous) = self.entries.remove(name) {
            self.bytes -= previous.len();
        }
        if self.bytes + bytes.len() > MAX_BYTES {
            self.entries.clear();
            self.bytes = 0;
        }
        self.bytes += bytes.len();
        self.entries.insert(name.into(), bytes.clone());
    }
}

/// Local read projections only. Remote review/revocation always uses its own path.
#[derive(Default)]
pub(crate) struct ProjectionCache(Mutex<Encoded>);

impl ProjectionCache {
    pub(crate) fn read(&self, options: Options, name: &str) -> Result<Option<Bytes>> {
        if !views::projected_file(name) {
            return Ok(None);
        }
        // Always reopen the authority: a warm cache must never hide a missing or
        // invalid database. File identity also invalidates a restored/replaced DB.
        let catalog = Catalog::open(options)?;
        let transaction = catalog.connection.unchecked_transaction()?;
        let identity = {
            let mut cache = self.0.lock().unwrap();
            // BEGIN is deferred: the first SELECT establishes the read snapshot.
            // Select the cache generation under the same lock, so an old snapshot
            // cannot arrive late and replace a newer generation before encoding.
            let identity = (
                crate::file_identity::path(&catalog.options.database, false)?,
                catalog.version()?,
            );
            cache.select(&identity);
            if let Some(bytes) = cache.entries.get(name) {
                return Ok(Some(bytes.clone()));
            }
            identity
        };
        // Read the version and all payloads in one SQLite snapshot. Encoding and
        // cache misses stay outside the mutex so unrelated page loads can proceed.
        let Some(value) = catalog.projection_owned(name)? else {
            return Ok(None);
        };
        transaction.commit()?;
        let bytes = Bytes::from(serde_json::to_vec(&value)?);
        self.0.lock().unwrap().publish(&identity, name, &bytes);
        Ok(Some(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_encoded_response_does_not_replace_a_newer_generation() {
        let file = crate::file_identity::Identity {
            dev: 1,
            ino: 1,
            links: 1,
        };
        let older = (file.clone(), 1);
        let newer = (file, 2);
        let bytes = Bytes::from_static(b"newer");
        let mut cache = Encoded::default();
        cache.select(&older);
        cache.select(&newer);
        cache.publish(&newer, "scenes.json", &bytes);
        cache.publish(&older, "scenes.json", &Bytes::from_static(b"older"));
        assert_eq!(cache.identity, Some(newer));
        assert_eq!(cache.entries["scenes.json"].as_ptr(), bytes.as_ptr());
        assert_eq!(cache.bytes, bytes.len());
    }
}
