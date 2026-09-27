use super::{
    Error, Result, codec,
    context::{Context, Options},
    fs, identity,
};
use serde_json::{Value, json};
use std::path::PathBuf;

pub(super) struct Journal {
    pub value: Value,
    pub hash: String,
    pub directory: Value,
}
pub(super) fn nonce(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 36
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    })
}
fn pid(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
}
pub(super) fn read(ctx: &Context) -> Result<Option<Journal>> {
    if fs::safe(&ctx.lease, true, true)?.is_none() {
        return Ok(None);
    }
    let bytes = fs::read(&ctx.lease.join("journal.json"), false)?.unwrap();
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(Error::journal("元数据过大"));
    }
    let journal = codec::unseal(
        serde_json::from_slice(&bytes).map_err(|_| Error::journal("元数据不是有效 JSON"))?,
        &ctx.key(false)?,
    )?;
    let participants = journal["participants"].as_array();
    if journal["schemaVersion"] != 1
        || journal["kind"] != "maintenance-journal"
        || !pid(&journal["pid"])
        || !nonce(&journal["nonce"])
        || !codec::equal(&journal["root"], &ctx.root_identity)
        || !journal["runtimeRoot"]
            .as_str()
            .is_some_and(|path| fs::same(std::path::Path::new(path), &ctx.options.runtime))
        || !codec::equal(
            &journal["runtimeIdentity"],
            &fs::directory_identity(&ctx.options.runtime)?,
        )
        || !journal["phase"].as_str().is_some_and(|s| {
            [
                "preparing",
                "writing",
                "rolling-back",
                "committed",
                "rolled-back",
                "recovering",
                "recovery-failed",
                "recovered",
                "INCONSISTENT",
            ]
            .contains(&s)
        })
        || participants.is_none_or(|entries| {
            entries.iter().any(|entry| {
                !pid(&entry["pid"])
                    || !matches!(entry["state"].as_str(), Some("running" | "exited"))
            })
        })
    {
        return Err(Error::journal("维护 journal 格式或根身份无效"));
    }
    if journal["phase"] != "preparing"
        && !(journal["phase"] == "recovered" && journal["noMutation"] == true)
        && (!journal["backup"]["id"].is_string() || !sha(&journal["backup"]["sha256"]))
    {
        return Err(Error::journal("维护 journal 缺少已建立备份"));
    }
    Ok(Some(Journal {
        value: journal,
        hash: codec::digest(bytes),
        directory: fs::directory_identity(&ctx.lease)?,
    }))
}
pub(super) fn sha(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(super) fn owner_dead(journal: &Value) -> bool {
    identity::process(journal["pid"].as_u64().unwrap_or(0)) == "dead"
        && journal["participants"].as_array().is_some_and(|entries| {
            entries.iter().all(|entry| {
                entry["state"] == "exited"
                    || identity::process(entry["pid"].as_u64().unwrap_or(0)) == "dead"
            })
        })
}
pub(super) struct RecoveryOwner {
    pub value: Value,
    pub directory: PathBuf,
    pub finished: bool,
    pub process: &'static str,
}
pub(super) fn recovery_owners(ctx: &Context, journal: &Value) -> Result<Vec<RecoveryOwner>> {
    let mut result = Vec::new();
    let mut directory = ctx.lease.join("recovery");
    while fs::safe(&directory, true, true)?.is_some() {
        if result.len() >= 32 {
            return Err(Error::journal("恢复重入层数超过安全上限"));
        }
        let value = ctx.read_signed(&directory.join("owner.json"))?;
        if !pid(&value["pid"])
            || !nonce(&value["nonce"])
            || value["transaction"] != journal["nonce"]
        {
            return Err(Error::journal("恢复锁身份无效"));
        }
        let finished = if fs::safe(&directory.join("finished.json"), false, true)?.is_some() {
            let finish = ctx.read_signed(&directory.join("finished.json"))?;
            if finish["nonce"] != value["nonce"] || finish["transaction"] != journal["nonce"] {
                return Err(Error::journal("恢复结束标记无效"));
            }
            true
        } else {
            false
        };
        let process = identity::process(value["pid"].as_u64().unwrap_or(0));
        result.push(RecoveryOwner {
            value,
            directory: directory.clone(),
            finished,
            process,
        });
        directory = directory.join("next");
    }
    Ok(result)
}
pub fn inspect(options: &Options) -> Value {
    let run = || -> Result<Value> {
        let ctx = Context::new(options)?;
        let Some(current) = read(&ctx)? else {
            return Ok(json!({"status":"free","recoveryRequired":false}));
        };
        let owners = recovery_owners(&ctx, &current.value)?;
        let active = owners
            .iter()
            .find(|owner| !owner.finished && owner.process != "dead");
        Ok(
            json!({"status":if !owner_dead(&current.value)||active.is_some(){"active"}else{"stale"},"recoveryRequired":true,"journal":current.value,"journalSha256":current.hash,
            "recoveryOwner":active.map(|owner|json!({"pid":owner.value["pid"],"nonce":owner.value["nonce"]}))}),
        )
    };
    run().unwrap_or_else(|error|json!({"status":"invalid","recoveryRequired":true,"code":error.code,"error":error.message}))
}
pub(super) fn blocked(state: &Value) -> Error {
    let status = state["status"].as_str().unwrap_or("invalid");
    let code = match status {
        "active" => "MAINTENANCE_BUSY",
        "invalid" => "MAINTENANCE_INVALID_JOURNAL",
        _ => "MAINTENANCE_RECOVERY_REQUIRED",
    };
    let mut error = Error::new(
        409,
        code,
        if status == "active" {
            "维护事务仍在运行，请稍后重试"
        } else {
            "维护事务尚未完整结束，请先预览并执行恢复"
        },
    );
    error.extra = json!({"transactionId":state["journal"]["nonce"],"phase":state["journal"]["phase"],"leaseStatus":status,"recoveryRequired":true}).into();
    error
}
pub fn read_token(options: &Options) -> Result<Option<String>> {
    let state = inspect(options);
    if state["status"] != "free" {
        return Err(blocked(&state));
    }
    let ctx = Context::new(options)?;
    let path = ctx.state.join("epoch.json");
    if fs::safe(&path, false, true)?.is_none() {
        return Ok(None);
    }
    let value = ctx.read_signed(&path)?;
    if !nonce(&value["nonce"]) || !codec::equal(&value["root"], &ctx.root_identity) {
        return Err(Error::journal("维护读取代次无效"));
    }
    let state = inspect(options);
    if state["status"] != "free" {
        return Err(blocked(&state));
    }
    Ok(value["nonce"].as_str().map(str::to_owned))
}
pub fn assert_token(options: &Options, token: &Option<String>) -> Result<()> {
    if &read_token(options)? != token {
        Err(Error::conflict("读取期间维护事务已变化，请重新读取"))
    } else {
        Ok(())
    }
}
pub(super) fn write(ctx: &Context, mut value: Value) -> Result<()> {
    value["updatedAt"] = codec::timestamp().into();
    ctx.write_signed(&ctx.lease.join("journal.json"), value)
}
pub(super) fn publish(
    ctx: &Context,
    target: &std::path::Path,
    name: &str,
    value: Value,
) -> Result<()> {
    let staging = ctx.state.join(format!(".claim-{}", uuid::Uuid::new_v4()));
    fs::ensure(&staging)?;
    ctx.write_signed(&staging.join(name), value)?;
    let result = (|| {
        fs::safe(target.parent().unwrap(), true, false)?;
        std::fs::rename(&staging, target)?;
        fs::sync(target.parent().unwrap())
    })();
    if result.is_err() {
        let _ = fs::remove(&staging.join(name));
        let _ = std::fs::remove_dir(&staging);
    }
    result
}
pub(super) fn archive(ctx: &Context, nonce: &str) -> Result<()> {
    let directory = ctx.state.join("completed");
    fs::ensure(&directory)?;
    let target = directory.join(nonce);
    if fs::safe(&target, true, true)?.is_some() {
        return Err(Error::conflict("事务归档身份已存在"));
    }
    ctx.write_signed(
        &ctx.state.join("epoch.json"),
        json!({"nonce":nonce,"root":ctx.root_identity}),
    )?;
    std::fs::rename(&ctx.lease, target)?;
    fs::sync(&ctx.state)
}
