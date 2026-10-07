//! Record content authority. JSON is an explicit seed/export, never a second writer.
mod check;
mod cli;
mod dependencies;
mod facet_cache;
mod http;
mod import;
mod migration;
mod projection_cache;
mod query;
mod snapshots;
#[cfg(test)]
mod tests;
mod validation;
mod views;
mod write;

use crate::error::{ApiError, Result};
pub use cli::run as cli;
pub(crate) use facet_cache::FacetCache;
pub use http::router;
pub(crate) use projection_cache::ProjectionCache;
pub use query::Query;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
pub use write::Change;

pub const KINDS: &[&str] = &["character", "outfit", "scene", "blueprint", "document"];
#[derive(Clone)]
pub struct Options {
    pub source: PathBuf,
    pub database: PathBuf,
}
impl Options {
    pub fn from_config(config: &crate::config::Config) -> Self {
        Self {
            source: config.content_root(),
            database: config.runtime_root.join("content/catalog.sqlite"),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub kind: String,
    pub id: String,
    pub revision: i64,
    pub sort_order: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub data: Value,
}
pub struct Catalog {
    connection: Connection,
    options: Options,
}
fn now() -> String {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).to_rfc3339()
}
fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Record> {
    let text: String = row.get(6)?;
    Ok(Record {
        kind: row.get(0)?,
        id: row.get(1)?,
        revision: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        data: serde_json::from_str(&text).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))
        })?,
    })
}
const COLUMNS: &str = "kind,id,revision,sort_order,created_at,updated_at,payload";
impl Catalog {
    pub fn open(options: Options) -> Result<Self> {
        let marker = options.database.with_extension("identity.json");
        if marker.exists() && !options.database.is_file() {
            return Err(ApiError::new(
                503,
                "CATALOG_MISSING",
                "已启用的内容库缺失，请恢复内容快照或备份",
            ));
        }
        if let Some(parent) = options.database.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&options.database)?;
        connection.busy_timeout(std::time::Duration::from_secs(10))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS content_records (
                kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,sort_order INTEGER NOT NULL,
                created_at TEXT,updated_at TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),
                title TEXT NOT NULL,character_id TEXT NOT NULL,category TEXT NOT NULL,rating TEXT NOT NULL,search_text TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)),PRIMARY KEY(kind,id));
            CREATE INDEX IF NOT EXISTS catalog_browse ON content_records(kind,deleted,character_id,category,rating,sort_order,id);
            CREATE INDEX IF NOT EXISTS catalog_recent ON content_records(kind,deleted,created_at,id);
            CREATE INDEX IF NOT EXISTS catalog_order ON content_records(kind,deleted,sort_order,id);
            CREATE TABLE IF NOT EXISTS content_seed (kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS content_history (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,
                revision INTEGER NOT NULL,at TEXT NOT NULL,record TEXT NOT NULL,deleted INTEGER NOT NULL,
                UNIQUE(kind,id,revision));")?;
        let mut store = Self {
            connection,
            options,
        };
        let initialized: Option<String> = store
            .connection
            .query_row(
                "SELECT value FROM catalog_meta WHERE key='schema'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        match initialized.as_deref() {
            None if marker.exists() => {
                return Err(ApiError::new(
                    503,
                    "CATALOG_INVALID",
                    "内容库结构缺失，请恢复备份",
                ));
            }
            None => store.initialize()?,
            Some("1") => (),
            _ => {
                return Err(ApiError::new(
                    503,
                    "CATALOG_SCHEMA",
                    "内容库版本不受支持，请使用匹配版本的程序",
                ));
            }
        }
        if !marker.exists() {
            crate::maintenance::fs::write_json(
                &marker,
                &json!({"schemaVersion":1,"initializedAt":now()}),
            )
            .map_err(|e| ApiError::new(e.status.as_u16(), e.code, e.message))?;
        }
        Ok(store)
    }
    pub fn get(&self, kind: &str, id: &str) -> Result<Record> {
        validation::key(kind, id)?;
        self.connection
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM content_records WHERE kind=?1 AND id=?2 AND deleted=0"
                ),
                params![kind, id],
                row,
            )
            .optional()?
            .ok_or_else(|| ApiError::new(404, "CATALOG_NOT_FOUND", "记录不存在或已下架"))
    }
    pub fn records(&self, kind: &str) -> Result<Vec<Record>> {
        let mut statement = self.connection.prepare(&format!("SELECT {COLUMNS} FROM content_records WHERE kind=?1 AND deleted=0 ORDER BY sort_order,id"))?;
        Ok(statement
            .query_map([kind], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn version(&self) -> Result<i64> {
        self.connection
            .query_row(
                "SELECT value FROM catalog_meta WHERE key='version'",
                [],
                |r| r.get::<_, String>(0),
            )?
            .parse()
            .map_err(|_| ApiError::new(503, "CATALOG_VERSION", "内容库版本无效"))
    }
    pub fn document(&self, id: &str) -> Result<Value> {
        Ok(self.get("document", id)?.data)
    }
    pub fn stats(&self) -> Result<Value> {
        let mut counts = serde_json::Map::new();
        for kind in KINDS {
            counts.insert(
                (*kind).into(),
                self.connection
                    .query_row(
                        "SELECT count(*) FROM content_records WHERE kind=?1 AND deleted=0",
                        [kind],
                        |r| r.get::<_, i64>(0),
                    )?
                    .into(),
            );
        }
        Ok(
            json!({"ok":true,"version":self.version()?,"counts":counts,"nextSceneId":self.next_scene_id()?,"authority":"sqlite","schemaVersion":1}),
        )
    }
}
