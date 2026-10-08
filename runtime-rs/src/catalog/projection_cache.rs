use super::*;
use axum::body::Bytes;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct Projection {
    pub(crate) bytes: Bytes,
    pub(crate) tag: String,
}

#[derive(Default)]
struct Encoded {
    identity: Option<(crate::file_identity::Identity, i64)>,
    entries: HashMap<String, Projection>,
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
        projection: &Projection,
    ) {
        // An older request can finish encoding after a newer commit has already
        // populated the cache. It may answer its own reader, never rewind the cache.
        if self.identity.as_ref() != Some(identity) || projection.bytes.len() > MAX_BYTES {
            return;
        }
        if let Some(previous) = self.entries.remove(name) {
            self.bytes -= previous.bytes.len();
        }
        if self.bytes + projection.bytes.len() > MAX_BYTES {
            self.entries.clear();
            self.bytes = 0;
        }
        self.bytes += projection.bytes.len();
        self.entries.insert(name.into(), projection.clone());
    }
}

/// Local read projections only. Remote review/revocation always uses its own path.
#[derive(Default)]
pub(crate) struct ProjectionCache {
    encoded: Mutex<Encoded>,
    encoder: OnceLock<uuid::Uuid>,
    // Keys are restricted to the finite projected-file allowlist.
    flights: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl ProjectionCache {
    pub(crate) fn read(&self, options: Options, name: &str) -> Result<Option<Projection>> {
        if !views::projected_file(name) {
            return Ok(None);
        }
        let flight = self
            .flights
            .lock()
            .unwrap()
            .entry(name.into())
            .or_default()
            .clone();
        // A leader can use its first read snapshot. Warm followers still check
        // authority in parallel, and only a cold follower waits/reopens.
        let mut guard = flight.try_lock().ok();
        loop {
            // Always reopen the authority: a warm cache must never hide a missing or
            // invalid database. File identity also invalidates a restored/replaced DB.
            let catalog = Catalog::open(options.clone())?;
            let transaction = catalog.connection.unchecked_transaction()?;
            let identity = {
                let mut cache = self.encoded.lock().unwrap();
                // BEGIN is deferred: the first SELECT establishes the read snapshot.
                // Select the cache generation under the same lock, so an old snapshot
                // cannot arrive late and replace a newer generation before encoding.
                let identity = (
                    crate::file_identity::path(&catalog.options.database, false)?,
                    catalog.version()?,
                );
                cache.select(&identity);
                if let Some(projection) = cache.entries.get(name) {
                    return Ok(Some(projection.clone()));
                }
                identity
            };
            if guard.is_none() {
                // Never pin an old SQLite snapshot while waiting for another encoder.
                // Warm reads do not take this lock; cold followers recheck authority.
                drop(transaction);
                drop(catalog);
                guard = Some(flight.lock().unwrap());
                continue;
            }
            // Read the version and all payloads in one SQLite snapshot. Encoding and
            // cache misses stay outside the mutex so unrelated page loads can proceed.
            let Some(value) = catalog.projection_owned(name)? else {
                return Ok(None);
            };
            transaction.commit()?;
            let bytes = Bytes::from(serde_json::to_vec(&value)?);
            // The same authority key already governs byte-cache validity. Bind
            // validators to this encoder lifetime as well, so a changed binary
            // cannot validate a previous process's differently encoded response.
            let stamp = format!(
                "{:?}/{}/{}",
                identity,
                self.encoder.get_or_init(uuid::Uuid::new_v4),
                name
            );
            let projection = Projection {
                tag: hex::encode(Sha256::digest(stamp.as_bytes())),
                bytes,
            };
            self.encoded
                .lock()
                .unwrap()
                .publish(&identity, name, &projection);
            return Ok(Some(projection));
        }
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
        let projection = Projection {
            bytes: Bytes::from_static(b"newer"),
            tag: "newer".into(),
        };
        let mut cache = Encoded::default();
        cache.select(&older);
        cache.select(&newer);
        cache.publish(&newer, "scenes.json", &projection);
        cache.publish(
            &older,
            "scenes.json",
            &Projection {
                bytes: Bytes::from_static(b"older"),
                tag: "older".into(),
            },
        );
        assert_eq!(cache.identity, Some(newer));
        assert_eq!(
            cache.entries["scenes.json"].bytes.as_ptr(),
            projection.bytes.as_ptr()
        );
        assert_eq!(cache.entries["scenes.json"].tag, projection.tag);
        assert_eq!(cache.bytes, projection.bytes.len());
    }
}
