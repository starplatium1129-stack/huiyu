use super::*;
use axum::extract::Path as RoutePath;
use rusqlite::{
    Connection, OptionalExtension, TransactionBehavior,
    backup::{Backup, StepResult},
    params,
};

const GROUP_LIMIT: usize = 64;
const TOTAL_LIMIT: usize = 1024;
const AGE_MS: i64 = 60 * 60_000;

pub(super) struct GroupHistory {
    store: Arc<AsyncMutex<Option<Database>>>,
}

struct Database {
    connection: Connection,
    generation: String,
    persistent: bool,
}

impl Database {
    fn open(
        mut connection: Connection,
        generation: &str,
        persistent: bool,
    ) -> rusqlite::Result<Self> {
        connection.busy_timeout(Duration::from_secs(2))?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS binding (slot INTEGER PRIMARY KEY CHECK(slot = 1), generation TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS messages (
                 sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
                 conversation TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS conversation_order ON messages(conversation, sequence);",
        )?;
        let previous: Option<String> = tx
            .query_row("SELECT generation FROM binding WHERE slot = 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        if previous.as_deref() != Some(generation) {
            tx.execute("DELETE FROM messages", [])?;
            tx.execute(
                "INSERT OR REPLACE INTO binding(slot, generation) VALUES (1, ?1)",
                [generation],
            )?;
        }
        tx.execute("DELETE FROM messages WHERE recorded_at < ?1", [oldest()])?;
        tx.commit()?;
        Ok(Self {
            connection,
            generation: generation.to_owned(),
            persistent,
        })
    }

    fn record(
        &mut self,
        group: &str,
        event: &str,
        value: &Value,
        previous_limit: usize,
    ) -> rusqlite::Result<Vec<Arc<Value>>> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM binding WHERE slot = 1 AND generation = ?1)",
            [&self.generation],
            |row| row.get(0),
        )?;
        if !active {
            // A reply from an old binding may already have its QQ receipt.
            return Ok(Vec::new());
        }
        let recorded = crate::host::now_ms() as i64;
        tx.execute(
            "DELETE FROM messages WHERE recorded_at < ?1",
            [recorded.saturating_sub(AGE_MS)],
        )?;
        let inserted = tx.execute(
            "INSERT INTO messages(event_id, conversation, recorded_at, payload) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(event_id) DO NOTHING",
            params![event, group, recorded, value.to_string()],
        )?;
        let previous = if previous_limit > 0 {
            Self::recent(
                &tx,
                &self.generation,
                group,
                Some(event),
                previous_limit.min(GROUP_LIMIT),
            )?
        } else {
            Vec::new()
        };
        if inserted != 0 {
            tx.execute(
                "DELETE FROM messages WHERE conversation = ?1 AND sequence <= (
                     SELECT sequence FROM messages WHERE conversation = ?1 ORDER BY sequence DESC LIMIT 1 OFFSET ?2)",
                params![group, GROUP_LIMIT as i64],
            )?;
            tx.execute(
                "DELETE FROM messages WHERE sequence <= (SELECT sequence FROM messages ORDER BY sequence DESC LIMIT 1 OFFSET ?1)",
                [TOTAL_LIMIT as i64],
            )?;
        }
        tx.commit()?;
        Ok(previous)
    }

    fn recent(
        connection: &Connection,
        generation: &str,
        group: &str,
        before: Option<&str>,
        limit: usize,
    ) -> rusqlite::Result<Vec<Arc<Value>>> {
        // sequence is assigned on receipt. QQ event timestamps and the host clock can differ.
        let mut query = connection.prepare_cached(
            "SELECT payload FROM messages
             WHERE conversation = ?1 AND recorded_at >= ?2
               AND (?3 IS NULL OR sequence < (SELECT sequence FROM messages WHERE event_id = ?3))
               AND EXISTS(SELECT 1 FROM binding WHERE slot = 1 AND generation = ?4)
             ORDER BY sequence DESC LIMIT ?5",
        )?;
        let rows = query.query_map(
            params![group, oldest(), before, generation, limit as i64],
            |row| {
                let payload: String = row.get(0)?;
                serde_json::from_str::<Value>(&payload)
                    .map(Arc::new)
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
            },
        )?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        items.reverse();
        Ok(items)
    }

    fn move_to_memory(&mut self) -> rusqlite::Result<()> {
        let mut memory = Connection::open_in_memory()?;
        let copied = Backup::new(&self.connection, &mut memory)
            .is_ok_and(|backup| matches!(backup.step(-1), Ok(StepResult::Done)));
        if !copied {
            memory = Connection::open_in_memory()?;
        }
        *self = Self::open(memory, &self.generation, false)?;
        Ok(())
    }
}

fn oldest() -> i64 {
    (crate::host::now_ms() as i64).saturating_sub(AGE_MS)
}

impl GroupHistory {
    pub(super) async fn open(path: PathBuf, generation: String) -> Self {
        let store = tokio::task::spawn_blocking(move || {
            Connection::open(path)
                .and_then(|connection| Database::open(connection, &generation, true))
                .or_else(|_| {
                    eprintln!("QQ 群上下文暂时无法保存到本机，本次连接将使用内存");
                    Database::open(Connection::open_in_memory()?, &generation, false)
                })
                .ok()
        })
        .await
        .unwrap_or_default();
        Self {
            store: Arc::new(AsyncMutex::new(store)),
        }
    }

    async fn access(
        &self,
        work: impl Fn(&mut Database) -> rusqlite::Result<Vec<Arc<Value>>> + Send + 'static,
    ) -> Vec<Arc<Value>> {
        // Queue operations in arrival order without blocking the async executor on SQLite.
        let mut store = self.store.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || {
            let Some(db) = store.as_mut() else {
                return Vec::new();
            };
            match work(db) {
                Ok(items) => items,
                Err(_) if db.persistent => {
                    eprintln!("QQ 群上下文存储暂时不可用，本次连接将使用内存");
                    db.move_to_memory()
                        .and_then(|()| work(db))
                        .unwrap_or_default()
                }
                Err(_) => Vec::new(),
            }
        })
        .await
        .unwrap_or_default()
    }

    pub(super) async fn receive(&self, entry: &Entry, previous_limit: usize) -> Vec<Arc<Value>> {
        let group = entry.conversation_id.clone();
        let event = crate::storage::json_fingerprint(&json!([group, entry.message_id]));
        let mut value = entry.sender_fields();
        value["author"] = json!("user");
        value["eventId"] = json!(event);
        value["timestamp"] = json!(entry.timestamp);
        value["text"] = json!(entry.question);
        value["ambient"] = json!(entry.ambient);
        if !entry.images.is_empty() {
            value["attachmentKind"] = json!("image");
            value["attachmentCount"] = json!(entry.images.len());
        }
        self.access(move |db| db.record(&group, &event, &value, previous_limit))
            .await
    }
}

impl Mailbox {
    pub(super) async fn remember_sent(
        &self,
        scope: QqScope,
        group: &str,
        kind: &str,
        text: Option<&str>,
    ) {
        if scope != QqScope::Group || self.cancel.is_cancelled() {
            return;
        }
        let group = group.to_owned();
        let event = uuid::Uuid::new_v4().to_string();
        let mut value = json!({
            "author":"muse","senderId":"muse","senderNickname":"Muse","senderRole":null,
            "timestamp":crate::host::now_ms(),"eventId":event,"text":text.unwrap_or_default()
        });
        if kind != "text" {
            value["attachmentKind"] = json!(kind);
            value["attachmentCount"] = json!(1);
        }
        self.history
            .access(move |db| db.record(&group, &event, &value, 0))
            .await;
    }
}

pub(super) async fn context(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>> {
    let settings = mailbox.settings(&app).await?;
    if !mailbox
        .targets(&settings)
        .iter()
        .any(|target| target.scope == QqScope::Group && target.conversation_id == id)
    {
        return Err(ApiError::new(
            403,
            "QQ_MUSE_TARGET",
            "此群会话未授权给 Muse",
        ));
    }
    let group = id.clone();
    let items = mailbox
        .history
        .access(move |db| {
            Database::recent(&db.connection, &db.generation, &group, None, GROUP_LIMIT)
        })
        .await;
    if mailbox.cancel.is_cancelled() {
        return Err(expired());
    }
    Ok(Json(json!({"ok":true,"conversationId":id,"items":items})))
}
