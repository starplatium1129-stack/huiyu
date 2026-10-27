//! Record content authority. JSON is an explicit seed/export, never a second writer.
mod authoring;
mod check;
mod cli;
mod dependencies;
mod facet_cache;
mod http;
mod import;
mod migration;
mod projection_cache;
mod provenance;
mod query;
mod showcase;
mod snapshots;

mod validation;
mod views;
mod write;

use crate::error::{ApiError, Result};
pub use cli::run as cli;
pub(crate) use facet_cache::FacetCache;
pub use http::router;
pub(crate) use projection_cache::ProjectionCache;
pub use query::Query;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
pub use write::Change;

pub const KINDS: &[&str] = &["character", "outfit", "scene", "blueprint", "document"];
#[derive(Clone)]
pub struct Options {
    pub source: PathBuf,
    pub seed_source: Option<PathBuf>,
    pub database: PathBuf,
}
impl Options {
    pub fn from_config(config: &crate::config::Config) -> Self {
        Self {
            source: config.content_root(),
            seed_source: config.is_packaged().then(|| config.app_root.clone()),
            database: config.runtime_root.join("content/catalog.sqlite"),
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
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
impl Record {
    pub(crate) fn into_value(mut self) -> serde_json::Result<Value> {
        let data = self.data.take();
        let mut value = serde_json::to_value(self)?;
        value["data"] = data;
        Ok(value)
    }
}
pub struct Catalog {
    connection: Connection,
    options: Options,
}
fn now() -> String {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).to_rfc3339()
}
fn text_column<'row>(row: &'row rusqlite::Row<'_>, column: usize) -> rusqlite::Result<&'row str> {
    // Borrow while SQLite owns the text, retaining column type and UTF-8 checks.
    match row.get_ref(column)? {
        rusqlite::types::ValueRef::Text(bytes) => {
            std::str::from_utf8(bytes).map_err(|error| rusqlite::Error::Utf8Error(column, error))
        }
        value => Err(rusqlite::Error::InvalidColumnType(
            column,
            row.as_ref().column_name(column)?.into(),
            value.data_type(),
        )),
    }
}
fn optional_text_column<'row>(
    row: &'row rusqlite::Row<'_>,
    column: usize,
) -> rusqlite::Result<Option<&'row str>> {
    if matches!(row.get_ref(column)?, rusqlite::types::ValueRef::Null) {
        Ok(None)
    } else {
        text_column(row, column).map(Some)
    }
}
fn json_column(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<Value> {
    serde_json::from_str(text_column(row, column)?).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Record> {
    let text = text_column(row, 6)?;
    Ok(Record {
        kind: row.get(0)?,
        id: row.get(1)?,
        revision: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        data: serde_json::from_str(text).map_err(|e| {
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
        let mut store = Self::connected(connection, options)?;
        store.ensure_schema(&marker, !marker.exists())?;
        Ok(store)
    }
    pub(crate) fn open_existing(options: Options) -> Result<Self> {
        if !options.database.is_file() {
            return Err(ApiError::new(
                503,
                "CATALOG_MISSING",
                "已启用的内容库缺失，请恢复内容快照或备份",
            ));
        }
        // Serving requests must never recreate a missing authority. Reopen on
        // every request so restored/replaced files still pass live validation.
        let connection = Connection::open_with_flags(
            &options.database,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let marker = options.database.with_extension("identity.json");
        let mut store = Self::connected(connection, options)?;
        store.validate_schema(false)?;
        let tables: i64 = store.connection.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('catalog_meta','content_records','content_seed','content_history')",
            [],
            |row| row.get(0),
        )?;
        if tables != 4 {
            return Err(ApiError::new(
                503,
                "CATALOG_INVALID",
                "内容库结构缺失，请恢复备份",
            ));
        }
        let indexed: bool = store.connection.query_row(
            "SELECT (SELECT count(*) FROM sqlite_schema WHERE type='index' AND name IN ('catalog_browse','catalog_newest','catalog_order'))=3 AND NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='catalog_recent')",
            [],
            |row| row.get(0),
        )?;
        let journal: String = store
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        if !indexed || journal != "wal" {
            // Old/restored snapshots retain the additive index upgrade contract;
            // current authorities skip all DDL on ordinary reads and cache hits.
            store.ensure_schema(&marker, false)?;
        } else {
            store.ensure_marker(&marker)?;
        }
        Ok(store)
    }
    fn connected(connection: Connection, options: Options) -> Result<Self> {
        connection.busy_timeout(std::time::Duration::from_secs(10))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        Ok(Self {
            connection,
            options,
        })
    }
    fn ensure_schema(&mut self, marker: &Path, initialize: bool) -> Result<()> {
        self.connection.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS content_records (
                kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,sort_order INTEGER NOT NULL,
                created_at TEXT,updated_at TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),
                title TEXT NOT NULL,character_id TEXT NOT NULL,category TEXT NOT NULL,rating TEXT NOT NULL,search_text TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)),PRIMARY KEY(kind,id));
            CREATE INDEX IF NOT EXISTS catalog_browse ON content_records(kind,deleted,character_id,category,rating,sort_order,id);
            CREATE INDEX IF NOT EXISTS catalog_newest ON content_records(kind,deleted,created_at DESC,sort_order,id);
            DROP INDEX IF EXISTS catalog_recent;
            CREATE INDEX IF NOT EXISTS catalog_order ON content_records(kind,deleted,sort_order,id);
            CREATE TABLE IF NOT EXISTS content_seed (kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS content_history (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,
                revision INTEGER NOT NULL,at TEXT NOT NULL,record TEXT NOT NULL,deleted INTEGER NOT NULL,
                UNIQUE(kind,id,revision));")?;
        self.validate_schema(initialize)?;
        self.ensure_marker(marker)
    }
    fn validate_schema(&mut self, initialize: bool) -> Result<()> {
        let initialized: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM catalog_meta WHERE key='schema'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        match initialized.as_deref() {
            None if !initialize => {
                return Err(ApiError::new(
                    503,
                    "CATALOG_INVALID",
                    "内容库结构缺失，请恢复备份",
                ));
            }
            None => self.initialize()?,
            Some("1") => self.migrate_seed_provenance()?,
            _ => {
                return Err(ApiError::new(
                    503,
                    "CATALOG_SCHEMA",
                    "内容库版本不受支持，请使用匹配版本的程序",
                ));
            }
        }
        Ok(())
    }
    fn ensure_marker(&self, marker: &Path) -> Result<()> {
        if !marker.exists() {
            crate::maintenance::fs::write_json(
                marker,
                &json!({"schemaVersion":1,"initializedAt":now()}),
            )
            .map_err(|e| ApiError::new(e.status.as_u16(), e.code, e.message))?;
        }
        Ok(())
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
    pub fn source_info(&self) -> Value {
        json!({"database":self.options.database,"contentRoot":self.options.source,"seedRoot":self.options.seed_source})
    }
    pub fn document(&self, id: &str) -> Result<Value> {
        Ok(self.get("document", id)?.data)
    }
    pub fn stats(&self) -> Result<Value> {
        // Counts, revision and the next ID must describe one committed catalog,
        // even while another connection imports or edits content.
        // check() already owns a read transaction; reuse its snapshot.
        let transaction = self
            .connection
            .is_autocommit()
            .then(|| self.connection.unchecked_transaction())
            .transpose()?;
        let mut counts: serde_json::Map<String, Value> = KINDS
            .iter()
            .map(|kind| ((*kind).into(), 0.into()))
            .collect();
        {
            let mut statement = self.connection.prepare(&format!(
                "SELECT kind,count(*) FROM content_records WHERE kind IN ({}) AND deleted=0 GROUP BY kind",
                vec!["?"; KINDS.len()].join(","),
            ))?;
            let mut rows = statement.query(rusqlite::params_from_iter(KINDS.iter().copied()))?;
            while let Some(row) = rows.next()? {
                let kind: String = row.get(0)?;
                if let Some(count) = counts.get_mut(&kind) {
                    *count = row.get::<_, i64>(1)?.into();
                }
            }
        }
        let value = json!({"ok":true,"version":self.version()?,"counts":counts,"nextSceneId":self.next_scene_id()?,"authority":"sqlite","schemaVersion":1,"source":self.source_info()});
        if let Some(transaction) = transaction {
            transaction.commit()?;
        }
        Ok(value)
    }
}
