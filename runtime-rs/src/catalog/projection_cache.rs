use super::*;
use axum::body::Bytes;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex, OnceLock},
};

const MAX_BYTES: usize = 16 * 1024 * 1024;
type Identity = (crate::file_identity::Identity, Vec<i64>);
type Observation = (uuid::Uuid, i64);

#[derive(Clone, Debug)]
pub(crate) struct Projection {
    pub(crate) bytes: Bytes,
    pub(crate) gzip: Option<Bytes>,
    pub(crate) tag: String,
}
impl Projection {
    fn size(&self) -> usize {
        self.bytes.len() + self.gzip.as_ref().map_or(0, Bytes::len)
    }
}

#[derive(Default)]
struct Encoded {
    identities: HashMap<String, Identity>,
    observations: HashMap<String, Observation>,
    entries: HashMap<String, Projection>,
    bytes: usize,
}
impl Encoded {
    fn select(&mut self, name: &str, identity: &Identity, observed: Observation) {
        self.observations.insert(name.into(), observed);
        if self.identities.get(name) != Some(identity) {
            if let Some(previous) = self.entries.remove(name) {
                self.bytes -= previous.size();
            }
            self.identities.insert(name.into(), identity.clone());
        }
    }
    fn publish(
        &mut self,
        identity: &Identity,
        name: &str,
        projection: &Projection,
    ) {
        // An older request can finish encoding after a newer commit has already
        // populated the cache. It may answer its own reader, never rewind the cache.
        if self.identities.get(name) != Some(identity) || projection.size() > MAX_BYTES {
            return;
        }
        if let Some(previous) = self.entries.remove(name) {
            self.bytes -= previous.size();
        }
        if self.bytes + projection.size() > MAX_BYTES {
            self.entries.clear();
            self.bytes = 0;
        }
        self.bytes += projection.size();
        self.entries.insert(name.into(), projection.clone());
    }
}

/// Local read projections only. Remote review/revocation always uses its own path.
#[derive(Default)]
pub(crate) struct ProjectionCache {
    reader: Reader,
    encoded: Mutex<Encoded>,
    encoder: OnceLock<uuid::Uuid>,
    // Keys are restricted to the finite projected-file allowlist.
    flights: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

enum Read {
    Hit(Projection),
    Wait,
    Unprojected,
    Encode(Identity, Value),
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
        // A leader can encode from its first read snapshot. Warm followers
        // reuse the reader and only cold followers wait on the encoder.
        let mut guard = flight.try_lock().ok();
        let cold_follower =
            guard.is_none() && !self.encoded.lock().unwrap().entries.contains_key(name);
        if cold_follower {
            // Release the cache lock before waiting. Recheck authority afterward.
            guard = Some(flight.lock().unwrap());
        }
        loop {
            let read = self.reader.with(options.clone(), |catalog, file, observed| {
                {
                    let cache = self.encoded.lock().unwrap();
                    if cache.observations.get(name) == Some(&observed)
                        && let Some(projection) = cache.entries.get(name)
                    {
                        return Ok(Read::Hit(projection.clone()));
                    }
                }
                let transaction = catalog.connection.unchecked_transaction()?;
                let identity = (file.clone(), catalog.projection_stamp(name)?);
                {
                    let mut cache = self.encoded.lock().unwrap();
                    cache.select(name, &identity, observed);
                    if let Some(projection) = cache.entries.get(name) {
                        return Ok(Read::Hit(projection.clone()));
                    }
                }
                if guard.is_none() {
                    // Don't pin a database snapshot while waiting for a flight.
                    return Ok(Read::Wait);
                }
                let Some(value) = catalog.projection_owned(name)? else {
                    return Ok(Read::Unprojected);
                };
                transaction.commit()?;
                Ok(Read::Encode(identity, value))
            })?;
            let (identity, value) = match read {
                Read::Hit(projection) => return Ok(Some(projection)),
                Read::Unprojected => return Ok(None),
                Read::Wait => {
                    guard = Some(flight.lock().unwrap());
                    continue;
                }
                Read::Encode(identity, value) => (identity, value),
            };
            // Serialize and compress after returning the connection to readers.
            let bytes = Bytes::from(serde_json::to_vec(&value)?);
            let gzip = if bytes.len() >= 32 * 1024 {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(&bytes)?;
                let packed = encoder.finish()?;
                (packed.len() < bytes.len()).then(|| Bytes::from(packed))
            } else {
                None
            };
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
                gzip,
            };
            self.encoded
                .lock()
                .unwrap()
                .publish(&identity, name, &projection);
            return Ok(Some(projection));
        }
    }
}
