use super::*;
use rusqlite::{Connection, OptionalExtension, params};

pub(super) struct Journal {
    db: Connection,
    fault: Option<String>,
}
fn unavailable(message: impl Into<String>) -> ApiError {
    ApiError::new(503, "OPERATION_JOURNAL_UNAVAILABLE", message)
}
impl Journal {
    pub(super) fn open(config: &Config) -> Result<Self> {
        let path = config.runtime_root.join("control-operations.sqlite");
        crate::maintenance::fs::ensure(&config.runtime_root)
            .map_err(|e| unavailable(e.to_string()))?;
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
            crate::maintenance::fs::safe(&candidate, false, true)
                .map_err(|e| unavailable(e.to_string()))?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(2))?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 1 {
            return Err(unavailable("操作记录版本较新，请更新绘遇后再继续"));
        }
        // This connection owns the journal until shutdown. SQLite releases the
        // exclusive OS lock after a crash, so another runtime cannot recover
        // records while their original owner is still executing.
        db.execute_batch(
            "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE;
            PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;
            CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, body TEXT NOT NULL);
            PRAGMA user_version=1;
            COMMIT;",
        )?;
        let mut journal = Self { db, fault: None };
        let interrupted = {
            let mut query = journal.db.prepare(
                "SELECT body FROM operations WHERE json_extract(body,'$.status')='running'",
            )?;
            query
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        for body in interrupted {
            let mut operation: Value = serde_json::from_str(&body)?;
            operation["status"] = json!("failed");
            operation["finishedAt"] = json!(now());
            operation["interrupted"] = json!(true);
            operation["error"] =
                json!("运行时已中断，已完成文件保留；请确认原安装器已退出，再重新检查清单后重试。");
            operation["message"] = operation["error"].clone();
            journal.save(&operation, false)?;
        }
        Ok(journal)
    }
    pub(super) fn get(&self, id: Option<&str>) -> Result<Option<Value>> {
        self.ready()?;
        let body: Option<String> = match id {
            Some(id) => self
                .db
                .query_row("SELECT body FROM operations WHERE id=?1", [id], |row| {
                    row.get(0)
                })
                .optional()?,
            None => self
                .db
                .query_row(
                    "SELECT body FROM operations ORDER BY rowid DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?,
        };
        body.map(|body| {
            let value: Value = serde_json::from_str(&body)?;
            if value["id"].as_str().is_none_or(str::is_empty)
                || !matches!(
                    value["status"].as_str(),
                    Some("running" | "completed" | "failed")
                )
                || !value["kind"].is_string()
                || !value["startedAt"].is_u64()
            {
                return Err(unavailable("操作记录无法读取，原记录已保留"));
            }
            Ok(value)
        })
        .transpose()
    }
    fn ready(&self) -> Result<()> {
        match &self.fault {
            Some(message) => Err(unavailable(message)),
            None => Ok(()),
        }
    }
    pub(super) fn save(&mut self, operation: &Value, insert: bool) -> Result<()> {
        self.ready()?;
        let id = operation["id"]
            .as_str()
            .ok_or_else(|| ApiError::invalid("缺少操作编号"))?;
        if insert && self.get(Some(id))?.is_some() {
            return Err(ApiError::new(
                409,
                "OPERATION_EXISTS",
                "此操作编号已提交，请读取原操作结果",
            ));
        }
        let result = self.db.execute(
            if insert {
                "INSERT INTO operations(id,body) VALUES(?1,?2)"
            } else {
                "UPDATE operations SET body=?2 WHERE id=?1"
            },
            params![id, serde_json::to_string(operation)?],
        );
        if !matches!(result, Ok(1)) {
            eprintln!("control operation journal: {result:?}");
            self.fault =
                Some("操作记录写入未确认，请保留当前窗口并检查磁盘；恢复前不能开始新操作。".into());
            return self.ready();
        }
        Ok(())
    }
}

impl ControlService {
    pub(super) fn journal_operation(&self, id: Option<&str>) -> Result<Option<Value>> {
        let journal = self.operation_journal.lock().unwrap();
        journal
            .as_ref()
            .map_err(|e| unavailable(e.to_string()))?
            .get(id)
    }
    pub(super) fn persist_operation(&self, operation: &Value, insert: bool) -> Result<()> {
        let mut journal = self.operation_journal.lock().unwrap();
        journal
            .as_mut()
            .map_err(|e| unavailable(e.to_string()))?
            .save(operation, insert)
    }
    pub(super) fn publish_operation(&self, operation: Value) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state
            .operation
            .as_ref()
            .is_none_or(|current| current["id"] != operation["id"])
        {
            return Err(ApiError::new(409, "OPERATION_CHANGED", "当前操作已改变"));
        }
        if let Err(error) = self.persist_operation(&operation, false) {
            if let Some(current) = state.operation.as_mut() {
                current["status"] = json!("failed");
                current["error"] = json!(error.message);
            }
            return Err(error);
        }
        state.operation = Some(operation);
        Ok(())
    }
    pub(super) fn checkpoint_operation(&self, state: &mut ControlState, force: bool) {
        if !force
            && state
                .operation_checkpoint
                .is_some_and(|at| at.elapsed() < Duration::from_secs(1))
        {
            return;
        }
        let Some(operation) = &state.operation else {
            return;
        };
        if let Err(error) = self.persist_operation(operation, false) {
            eprintln!("control operation checkpoint: {error}");
            if let Some(cancel) = self.environment_cancel.lock().unwrap().as_ref() {
                cancel.cancel();
            }
        }
        state.operation_checkpoint = Some(Instant::now());
    }
}
