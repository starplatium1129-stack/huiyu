use super::{
    Error, Result, backup, codec,
    context::{Context, Options},
    fs, identity, journal,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// A deliberately explicit lifecycle. Dropping an unfinished transaction keeps
/// its signed lease for recovery. Callers explicitly commit or roll back.
pub struct Transaction {
    ctx: Context,
    pub nonce: String,
    directory: Value,
    released: bool,
    prepared: Option<(String, String, std::collections::HashSet<String>)>,
}
impl Transaction {
    pub fn acquire(options: &Options) -> Result<Self> {
        let ctx = Context::new(options)?;
        let state = journal::inspect(options);
        if state["status"] != "free" {
            return Err(journal::blocked(&state));
        }
        fs::ensure(&ctx.options.runtime)?;
        ctx.key(true)?;
        let nonce = uuid::Uuid::new_v4().to_string();
        let value = json!({"schemaVersion":1,"kind":"maintenance-journal","root":ctx.root_identity,"runtimeRoot":ctx.options.runtime,
            "runtimeIdentity":fs::directory_identity(&ctx.options.runtime)?,"pid":std::process::id(),"nonce":nonce,"phase":"preparing","backup":null,"participants":[],"final":null,"createdAt":codec::timestamp(),"updatedAt":codec::timestamp()});
        if let Err(error) = journal::publish(&ctx, &ctx.lease, "journal.json", value) {
            let state = journal::inspect(options);
            return Err(if state["status"] != "free" {
                journal::blocked(&state)
            } else {
                error
            });
        }
        let directory = fs::directory_identity(&ctx.lease)?;
        Ok(Self {
            ctx,
            nonce,
            directory,
            released: false,
            prepared: None,
        })
    }
    fn owned(&self) -> Result<Value> {
        if self.released {
            return Err(Error::conflict("维护 lease 已释放"));
        }
        let ctx = Context::new(&self.ctx.options)?;
        let current = journal::read(&ctx)?.ok_or_else(|| Error::conflict("维护锁已丢失"))?;
        if current.value["pid"] != std::process::id()
            || current.value["nonce"] != self.nonce
            || !codec::equal(&self.directory, &current.directory)
        {
            return Err(Error::conflict("维护锁 PID/nonce/目录身份已变化"));
        }
        Ok(current.value)
    }
    pub(super) fn assert_owned(&self) -> Result<()> {
        self.owned().map(|_| ())
    }
    fn update(&self, patch: Value) -> Result<()> {
        let mut current = self.owned()?;
        current
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        journal::write(&self.ctx, current)?;
        self.owned()?;
        Ok(())
    }
    fn quiescent(&self) -> Result<()> {
        let value = self.owned()?;
        if value["participants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["state"] != "exited"
                    && identity::process(entry["pid"].as_u64().unwrap_or(0)) != "dead"
            })
        {
            return Err(Error::new(
                409,
                "MAINTENANCE_BUSY",
                "子进程仍可能写盘，拒绝提交或回滚",
            ));
        }
        Ok(())
    }
    pub fn prepare(&mut self, targets: &[PathBuf], label: &str) -> Result<String> {
        let value = self.owned()?;
        if value["phase"] != "preparing" || !value["backup"].is_null() {
            return Err(Error::conflict("事务备份只能建立一次"));
        }
        let snapshot = backup::capture(&self.ctx, targets)?;
        let backup = backup::save(&self.ctx, &snapshot, label)?;
        self.update(json!({"phase":"writing","backup":{"id":backup.id,"sha256":backup.hash}}))?;
        self.prepared = Some((
            backup.id.clone(),
            backup.hash,
            backup
                .entries
                .iter()
                .map(|entry| fs::key(&entry.file))
                .collect::<Result<_>>()?,
        ));
        Ok(backup.id)
    }
    pub fn add_participant(&self, pid: u32) -> Result<()> {
        if identity::process(pid as u64) != "alive" {
            return Err(Error::conflict("子进程尚未可确认运行"));
        }
        let value = self.owned()?;
        if value["phase"] != "writing" {
            return Err(Error::conflict("必须先建立备份再启动写入子进程"));
        }
        let mut entries = value["participants"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["pid"] != pid)
            .cloned()
            .collect::<Vec<_>>();
        entries.push(json!({"pid":pid,"state":"running"}));
        self.update(json!({"participants":entries}))
    }
    pub fn participant_exited(&self, pid: u32) -> Result<()> {
        let value = self.owned()?;
        let entries = value["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                if entry["pid"] == pid {
                    json!({"pid":pid,"state":"exited"})
                } else {
                    entry.clone()
                }
            })
            .collect::<Vec<_>>();
        self.update(json!({"participants":entries}))
    }
    fn backup(&self) -> Result<backup::Backup> {
        let journal = self.owned()?;
        backup::read(
            &self.ctx,
            journal["backup"]["id"]
                .as_str()
                .ok_or_else(|| Error::conflict("事务未建立备份"))?,
            journal["backup"]["sha256"].as_str(),
        )
    }
    fn writable(&self, target: &Path) -> Result<PathBuf> {
        let journal = self.owned()?;
        if journal["phase"] != "writing" {
            return Err(Error::conflict("事务未进入写入阶段"));
        }
        let path = self.ctx.target(target)?;
        let Some((id, hash, targets)) = &self.prepared else {
            return Err(Error::conflict("事务尚未准备写入范围"));
        };
        if journal["backup"]["id"] != *id
            || journal["backup"]["sha256"] != *hash
            || !targets.contains(&fs::key(&path)?)
        {
            return Err(Error::new(
                409,
                "MAINTENANCE_UNSUPPORTED_SCOPE",
                "写入目标未进入已封存快照",
            ));
        }
        Ok(path)
    }
    pub fn write(&self, target: &Path, bytes: &[u8]) -> Result<()> {
        fs::atomic(&self.writable(target)?, bytes, true)
    }
    pub fn remove(&self, target: &Path) -> Result<()> {
        fs::remove(&self.writable(target)?)
    }
    fn complete(&self, phase: &str) -> Result<()> {
        self.quiescent()?;
        let current = self.owned()?;
        if current["backup"].is_null() {
            if phase != "rolled-back" {
                return Err(Error::conflict("事务未建立备份"));
            }
            return Ok(());
        }
        let backup = self.backup()?;
        let mut final_state = Vec::new();
        for item in &backup.entries {
            let state = fs::state(&item.file)?;
            if phase == "rolled-back" && !codec::equal(&state, &item.expected) {
                return Err(Error::new(
                    409,
                    "MAINTENANCE_INCONSISTENT",
                    "回滚后原始字节不匹配",
                ));
            }
            let mut final_item = state;
            final_item["source"] = serde_json::to_value(&item.file).unwrap();
            final_state.push(final_item);
        }
        self.update(json!({"phase":phase,"final":final_state}))
    }
    fn release(&mut self) -> Result<()> {
        let current = self.owned()?;
        self.quiescent()?;
        if !matches!(
            current["phase"].as_str(),
            Some("preparing" | "committed" | "rolled-back")
        ) || (current["phase"] == "preparing" && !current["backup"].is_null())
        {
            return Err(Error::new(
                409,
                "MAINTENANCE_RECOVERY_REQUIRED",
                "尚未确认提交或完整回滚，保留维护锁",
            ));
        }
        journal::archive(&self.ctx, &self.nonce)?;
        self.released = true;
        Ok(())
    }
    pub fn commit(&mut self) -> Result<()> {
        self.complete("committed")?;
        self.release()
    }
    pub fn rollback(&mut self) -> Result<()> {
        let result = (|| {
            let current = self.owned()?;
            if !current["backup"].is_null() {
                self.quiescent()?;
                self.update(json!({"phase":"rolling-back"}))?;
                let backup = self.backup()?;
                backup::restore(&self.ctx, &backup.entries, || self.owned().map(|_| ()))?;
                self.complete("rolled-back")?;
            }
            self.release()
        })();
        if let Err(error) = &result {
            let _=self.update(json!({"phase":"INCONSISTENT","error":error.message.chars().take(2000).collect::<String>()}));
        }
        result
    }
}
