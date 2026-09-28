use super::{Error, Result, codec, context::Context, fs, journal};
use serde_json::{Value, json};
use std::path::PathBuf;

pub(super) struct Claim {
    ctx: Context,
    pub nonce: String,
    directory: PathBuf,
    transaction: String,
    lease_identity: Value,
    finished: bool,
}
impl Claim {
    pub fn acquire(ctx: &Context, expected: &str) -> Result<Self> {
        let original =
            journal::read(ctx)?.ok_or_else(|| Error::conflict("恢复计划的 journal 已变化"))?;
        if original.hash != expected {
            return Err(Error::conflict("恢复计划的 journal 已变化"));
        }
        if !journal::owner_dead(&original.value) {
            return Err(Error::new(
                409,
                "MAINTENANCE_BUSY",
                "原进程或子进程仍活着，绝不抢占",
            ));
        }
        let nonce = uuid::Uuid::new_v4().to_string();
        let transaction = original.value["nonce"].as_str().unwrap().to_owned();
        let value = json!({"pid":std::process::id(),"nonce":nonce,"transaction":transaction,"createdAt":codec::timestamp()});
        let mut published = None;
        for attempt in 0..33 {
            let latest =
                journal::read(ctx)?.ok_or_else(|| Error::conflict("恢复抢锁期间事务发生变化"))?;
            if latest.hash != expected || !codec::equal(&latest.directory, &original.directory) {
                return Err(Error::conflict("恢复抢锁期间事务发生变化"));
            }
            let owners = journal::recovery_owners(ctx, &latest.value)?;
            if owners
                .iter()
                .any(|owner| !owner.finished && owner.process != "dead")
            {
                return Err(Error::new(
                    409,
                    "MAINTENANCE_BUSY",
                    "另一个恢复进程仍在运行",
                ));
            }
            let directory = owners
                .last()
                .map(|owner| owner.directory.join("next"))
                .unwrap_or_else(|| ctx.lease.join("recovery"));
            match journal::publish(ctx, &directory, "owner.json", value.clone()) {
                Ok(()) => {
                    published = Some(directory);
                    break;
                }
                Err(error) => {
                    if fs::safe(&directory, true, true)?.is_none() || attempt == 32 {
                        return Err(error);
                    }
                }
            }
        }
        let result = Self {
            ctx: ctx.clone(),
            nonce,
            directory: published.ok_or_else(|| Error::conflict("恢复锁无法建立"))?,
            transaction,
            lease_identity: original.directory,
            finished: false,
        };
        result.owned()?;
        Ok(result)
    }
    pub fn owned(&self) -> Result<Value> {
        let ctx = Context::new(&self.ctx.options)?;
        let current = journal::read(&ctx)?.ok_or_else(|| Error::conflict("恢复锁身份变化"))?;
        if self.finished
            || current.value["nonce"] != self.transaction
            || !codec::equal(&current.directory, &self.lease_identity)
            || !journal::owner_dead(&current.value)
        {
            return Err(Error::conflict("恢复锁身份变化或原进程仍活着"));
        }
        let owners = journal::recovery_owners(&ctx, &current.value)?;
        if owners.last().is_none_or(|owner| {
            owner.value["nonce"] != self.nonce
                || owner.value["pid"] != std::process::id()
                || owner.finished
        }) {
            return Err(Error::conflict("恢复锁已变化"));
        }
        Ok(current.value)
    }
    pub fn update(&self, patch: Value) -> Result<()> {
        let mut value = self.owned()?;
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        journal::write(&self.ctx, value)
    }
    pub fn finish(&mut self) -> Result<()> {
        self.owned()?;
        self.ctx.write_signed(
            &self.directory.join("finished.json"),
            json!({"nonce":self.nonce,"transaction":self.transaction}),
        )?;
        self.finished = true;
        Ok(())
    }
    pub fn release(&mut self) -> Result<()> {
        let current = self.owned()?;
        if current["phase"] != "recovered" {
            return Err(Error::new(
                409,
                "MAINTENANCE_RECOVERY_REQUIRED",
                "恢复尚未核验完成",
            ));
        }
        journal::archive(&self.ctx, &self.transaction)?;
        self.finished = true;
        Ok(())
    }
}
