use crate::config::Config;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const CACHE_SCHEMA_VERSION: u32 = 1;
pub(super) const TTL_SECONDS: i64 = 14 * 24 * 60 * 60;
const TTL_MS: i64 = TTL_SECONDS * 1000;
const MAX_MEMORY_ENTRIES: usize = 128;
const MAX_DISK_ENTRIES: i64 = 1024;
const MAX_DISK_BYTES: i64 = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 256 * 1024;

#[derive(Clone)]
struct MemoryEntry {
    payload: Value,
    created_at: i64,
    last_accessed_at: i64,
    expires_at: i64,
}

struct Inner {
    memory: Mutex<HashMap<String, MemoryEntry>>,
    disk: Option<Mutex<Connection>>,
}

#[derive(Clone)]
pub(super) struct InterrogateCache {
    inner: Arc<Inner>,
}

pub(super) struct CacheKeyInput<'a> {
    pub(super) image_sha256: &'a str,
    pub(super) engine: &'a str,
    pub(super) mode: &'a str,
    pub(super) threshold: f64,
    pub(super) assist_identity: Option<&'a str>,
    pub(super) subject_mode: &'a str,
    pub(super) layout: bool,
}

pub(super) fn image_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn cache_key(input: &CacheKeyInput<'_>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "v{CACHE_SCHEMA_VERSION}\0{}\0{}\0{}\0{:.4}\0",
        input.image_sha256, input.engine, input.mode, input.threshold
    ));
    match input.assist_identity {
        Some(identity) => {
            hasher.update(format!(
                "assist:{identity}\0{}\0{}",
                input.subject_mode,
                if input.layout { "layout:1" } else { "layout:0" }
            ));
        }
        None => {
            hasher.update("assist:none");
        }
    }
    format!("{:x}", hasher.finalize())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn open_disk(path: PathBuf) -> std::result::Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create cache dir: {error}"))?;
    }
    let conn = Connection::open(&path).map_err(|error| format!("open sqlite: {error}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 3000;
         CREATE TABLE IF NOT EXISTS interrogate_cache (
             cache_key TEXT PRIMARY KEY,
             image_sha256 TEXT NOT NULL,
             payload TEXT NOT NULL,
             bytes INTEGER NOT NULL,
             created_at INTEGER NOT NULL,
             last_accessed_at INTEGER NOT NULL,
             expires_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_interrogate_cache_lru
             ON interrogate_cache(last_accessed_at);
         CREATE INDEX IF NOT EXISTS idx_interrogate_cache_expires
             ON interrogate_cache(expires_at);",
    )
    .map_err(|error| format!("init schema: {error}"))?;
    let _ = conn.execute(
        "DELETE FROM interrogate_cache WHERE expires_at <= ?1",
        params![now_ms()],
    );
    Ok(conn)
}

impl InterrogateCache {
    pub(super) fn new(config: &Config) -> Self {
        let path = config.runtime_root.join("cache/interrogate-results.sqlite");
        let disk = match open_disk(path) {
            Ok(conn) => Some(Mutex::new(conn)),
            Err(error) => {
                eprintln!("反推结果磁盘缓存不可用，已降级为纯内存缓存：{error}");
                None
            }
        };
        Self {
            inner: Arc::new(Inner {
                memory: Mutex::new(HashMap::new()),
                disk,
            }),
        }
    }

    pub(super) async fn get(&self, key: &str) -> Option<(Value, i64)> {
        let now = now_ms();
        {
            let mut memory = self.inner.memory.lock().unwrap();
            if let Some(entry) = memory.get_mut(key) {
                if entry.expires_at > now {
                    entry.last_accessed_at = now;
                    let hit = (entry.payload.clone(), entry.created_at);
                    let inner = self.inner.clone();
                    let key_owned = key.to_owned();
                    tokio::task::spawn_blocking(move || {
                        if let Some(disk) = &inner.disk
                            && let Ok(conn) = disk.lock()
                        {
                            let _ = conn.execute(
                                "UPDATE interrogate_cache SET last_accessed_at = ?1 WHERE cache_key = ?2",
                                params![now, key_owned],
                            );
                        }
                    });
                    return Some(hit);
                }
                memory.remove(key);
            }
        }
        if self.inner.disk.is_none() {
            return None;
        }
        let inner = self.inner.clone();
        let key_owned = key.to_owned();
        let disk_hit = tokio::task::spawn_blocking(move || -> Option<MemoryEntry> {
            let conn = inner.disk.as_ref()?.lock().ok()?;
            let (raw, created_at, expires_at): (String, i64, i64) = conn
                .query_row(
                    "SELECT payload, created_at, expires_at FROM interrogate_cache WHERE cache_key = ?1",
                    params![&key_owned],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .ok()??;
            if expires_at <= now {
                let _ = conn.execute(
                    "DELETE FROM interrogate_cache WHERE cache_key = ?1",
                    params![&key_owned],
                );
                return None;
            }
            let payload: Value = match serde_json::from_str(&raw) {
                Ok(value) => value,
                Err(_) => {
                    let _ = conn.execute(
                        "DELETE FROM interrogate_cache WHERE cache_key = ?1",
                        params![&key_owned],
                    );
                    return None;
                }
            };
            let _ = conn.execute(
                "UPDATE interrogate_cache SET last_accessed_at = ?1 WHERE cache_key = ?2",
                params![now, &key_owned],
            );
            Some(MemoryEntry {
                payload,
                created_at,
                last_accessed_at: now,
                expires_at,
            })
        })
        .await
        .ok()??;

        let result = (disk_hit.payload.clone(), disk_hit.created_at);
        self.insert_memory(key.to_owned(), disk_hit);
        Some(result)
    }

    pub(super) async fn put(&self, key: String, image_sha256: String, mut payload: Value) {
        if let Some(object) = payload.as_object_mut() {
            object.remove("cacheHit");
            object.remove("cachedAt");
            object.remove("requestKey");
            object.remove("savedJsonPath");
        }
        let Ok(serialized) = serde_json::to_string(&payload) else {
            return;
        };
        if serialized.len() > MAX_ENTRY_BYTES {
            return;
        }
        let now = now_ms();
        let expires_at = now.saturating_add(TTL_MS);
        self.insert_memory(
            key.clone(),
            MemoryEntry {
                payload,
                created_at: now,
                last_accessed_at: now,
                expires_at,
            },
        );
        if self.inner.disk.is_none() {
            return;
        }
        let inner = self.inner.clone();
        let bytes = serialized.len() as i64;
        let _ = tokio::task::spawn_blocking(move || {
            let Some(disk) = &inner.disk else {
                return;
            };
            let Ok(mut conn) = disk.lock() else {
                return;
            };
            let Ok(tx) = conn.transaction() else {
                return;
            };
            if tx
                .execute(
                    "INSERT OR REPLACE INTO interrogate_cache
                     (cache_key, image_sha256, payload, bytes, created_at, last_accessed_at, expires_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![key, image_sha256, serialized, bytes, now, now, expires_at],
                )
                .is_err()
            {
                return;
            }
            let _ = tx.execute(
                "DELETE FROM interrogate_cache WHERE expires_at <= ?1",
                params![now],
            );
            prune_disk(&tx);
            let _ = tx.commit();
        })
        .await;
    }

    pub(super) async fn stats(&self) -> Value {
        let now = now_ms();
        let memory_entries = {
            let mut memory = self.inner.memory.lock().unwrap();
            memory.retain(|_, entry| entry.expires_at > now);
            memory.len()
        };
        let persistent = self.inner.disk.is_some();
        let (disk_entries, disk_bytes) = if persistent {
            let inner = self.inner.clone();
            tokio::task::spawn_blocking(move || -> (i64, i64) {
                let Some(disk) = &inner.disk else {
                    return (0, 0);
                };
                let Ok(conn) = disk.lock() else {
                    return (0, 0);
                };
                conn.query_row(
                    "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM interrogate_cache WHERE expires_at > ?1",
                    params![now],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap_or((0, 0))
            })
            .await
            .unwrap_or((0, 0))
        } else {
            (0, 0)
        };
        json!({
            "enabled": true,
            "persistent": persistent,
            "ttlSeconds": TTL_SECONDS,
            "memoryEntries": memory_entries,
            "maxMemoryEntries": MAX_MEMORY_ENTRIES,
            "diskEntries": disk_entries,
            "maxDiskEntries": MAX_DISK_ENTRIES,
            "diskBytes": disk_bytes,
            "maxDiskBytes": MAX_DISK_BYTES
        })
    }

    fn insert_memory(&self, key: String, entry: MemoryEntry) {
        let now = entry.last_accessed_at;
        let mut memory = self.inner.memory.lock().unwrap();
        memory.retain(|_, value| value.expires_at > now);
        memory.insert(key, entry);
        while memory.len() > MAX_MEMORY_ENTRIES {
            let oldest = memory
                .iter()
                .min_by_key(|(_, value)| value.last_accessed_at)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(oldest_key) => {
                    memory.remove(&oldest_key);
                }
                None => break,
            }
        }
    }
}

fn prune_disk(tx: &rusqlite::Transaction<'_>) {
    let Ok((mut count, mut total_bytes)): rusqlite::Result<(i64, i64)> = tx.query_row(
        "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM interrogate_cache",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ) else {
        return;
    };
    while count > MAX_DISK_ENTRIES || total_bytes > MAX_DISK_BYTES {
        let victim: Option<(String, i64)> = tx
            .query_row(
                "SELECT cache_key, bytes FROM interrogate_cache ORDER BY last_accessed_at ASC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .ok()
            .flatten();
        let Some((victim_key, victim_bytes)) = victim else {
            break;
        };
        if tx
            .execute(
                "DELETE FROM interrogate_cache WHERE cache_key = ?1",
                params![victim_key],
            )
            .is_err()
        {
            break;
        }
        count -= 1;
        total_bytes = (total_bytes - victim_bytes).max(0);
    }
}
