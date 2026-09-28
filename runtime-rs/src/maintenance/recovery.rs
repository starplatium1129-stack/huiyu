use super::{
    Error, Result, backup, codec,
    context::{Context, Options},
    fs, journal,
    recovery_claim::Claim,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub fn preview(options: &Options, backup_id: Option<&str>) -> Result<Value> {
    let ctx = Context::new(options)?;
    let state = journal::inspect(options);
    let mut conflicts = Vec::new();
    if state["status"] != "stale" {
        conflicts.push(json!({"code":match state["status"].as_str(){Some("active")=>"MAINTENANCE_BUSY",Some("free")=>"MAINTENANCE_NO_TRANSACTION",_=>"MAINTENANCE_INVALID_JOURNAL"},"message":state["error"].as_str().unwrap_or("恢复只允许已确认退出的事务")}));
    }
    let journal = &state["journal"];
    let mut backup = None;
    if journal["backup"].is_object() && state["status"] == "stale" {
        match backup::read(
            &ctx,
            journal["backup"]["id"].as_str().unwrap_or(""),
            journal["backup"]["sha256"].as_str(),
        ) {
            Ok(value) => {
                if backup_id.is_some_and(|id| id != value.id) {
                    conflicts.push(json!({"code":"MAINTENANCE_CONFLICT","message":"所选备份不属于被恢复的事务"}));
                }
                backup = Some(value);
            }
            Err(error) => conflicts.push(json!({"code":error.code,"message":error.message})),
        }
    } else if backup_id.is_some_and(|id| journal["backup"]["id"] != id) {
        conflicts.push(json!({"code":"MAINTENANCE_CONFLICT","message":"备份与当前事务不匹配"}));
    }
    let terminal = matches!(
        journal["phase"].as_str(),
        Some("committed" | "rolled-back" | "recovered")
    );
    let mut entries = Vec::new();
    if let Some(backup) = &backup {
        for item in &backup.entries {
            match fs::state(&item.file) {
                Ok(current) => {
                    let desired = if terminal {
                        journal["final"].as_array().and_then(|items|items.iter().find(|entry|entry["source"].as_str().is_some_and(|file|Path::new(file)==item.file))).map(|entry|json!({"exists":entry["exists"],"sha256":entry["sha256"],"size":entry["size"]})).unwrap_or(Value::Null)
                    } else {
                        item.expected.clone()
                    };
                    if desired.is_null() || (terminal && !codec::equal(&current, &desired)) {
                        conflicts.push(json!({"code":"MAINTENANCE_CONFLICT","message":format!("已完成事务的最终文件发生漂移：{}",item.file.display())}));
                    }
                    entries.push(json!({"source":item.file,"current":current,"desired":desired,"action":if terminal{"keep"}else if item.content.is_none(){"remove-if-present"}else{"restore"}}));
                }
                Err(error) => conflicts.push(json!({"code":error.code,"message":error.message})),
            }
        }
    }
    if !journal.is_null()
        && journal["backup"].is_null()
        && journal["phase"] != "preparing"
        && !(journal["phase"] == "recovered" && journal["noMutation"] == true)
    {
        conflicts.push(json!({"code":"MAINTENANCE_INVALID_JOURNAL","message":"事务缺少备份"}));
    }
    let executable = conflicts.is_empty();
    let plan = json!({"schemaVersion":1,"kind":"maintenance-recovery-plan","root":ctx.root_identity,"runtimeRoot":ctx.options.runtime,
        "runtimeIdentity":if fs::safe(&ctx.options.runtime,true,true)?.is_some(){fs::directory_identity(&ctx.options.runtime)?}else{Value::Null},
        "showcaseIdentity":ctx.options.showcase.as_ref().map(|path|fs::directory_identity(path)).transpose()?,"showcaseRoot":ctx.options.showcase,
        "transactionId":journal["nonce"],"journalSha256":state["journalSha256"],"backupId":journal["backup"]["id"],"backupSha256":journal["backup"]["sha256"],
        "action":if terminal{"release-completed"}else if backup.is_some(){"restore"}else{"release-unstarted"},"entries":entries,"conflicts":conflicts,"executable":executable,"leaseStatus":state["status"]});
    Ok(if executable {
        codec::seal(plan, &ctx.key(false)?)
    } else {
        plan
    })
}

/// Explicit recovery API for a reviewed, signed plan. No HTTP route calls it
/// until the remaining content validators and publication paths are migrated.
pub fn apply(options: &Options, signed: Value) -> Result<Value> {
    let ctx = Context::new(options)?;
    let plan = codec::unseal(signed, &ctx.key(false)?)?;
    if plan["schemaVersion"] != 1
        || plan["kind"] != "maintenance-recovery-plan"
        || plan["executable"] != true
        || plan["conflicts"]
            .as_array()
            .is_none_or(|items| !items.is_empty())
        || !codec::equal(&plan["root"], &ctx.root_identity)
        || plan["runtimeRoot"] != serde_json::to_value(&ctx.options.runtime).unwrap()
        || plan["showcaseRoot"] != serde_json::to_value(&ctx.options.showcase).unwrap()
    {
        return Err(Error::new(
            409,
            "MAINTENANCE_INVALID_PLAN",
            "恢复计划无效或配置不匹配",
        ));
    }
    let current = preview(options, None)?;
    if current["executable"] != true
        || !codec::equal(&plan, &codec::unseal(current, &ctx.key(false)?)?)
    {
        return Err(Error::conflict(
            "文件、journal 或进程状态已变化；请重新预览",
        ));
    }
    let mut claim = Claim::acquire(
        &ctx,
        plan["journalSha256"]
            .as_str()
            .ok_or_else(|| Error::journal("恢复计划缺少 journal 哈希"))?,
    )?;
    let entries = plan["entries"]
        .as_array()
        .ok_or_else(|| Error::journal("恢复计划缺少文件列表"))?;
    let mut undo = None;
    let mut attempted = Vec::new();
    let result = (|| -> Result<Value> {
        for item in entries {
            let path = ctx.target(Path::new(
                item["source"]
                    .as_str()
                    .ok_or_else(|| Error::path("恢复目标无效"))?,
            ))?;
            if !codec::equal(&fs::state(&path)?, &item["current"]) {
                return Err(Error::conflict("恢复抢锁后当前字节发生变化"));
            }
        }
        if plan["action"] == "restore" {
            let backup = backup::read(
                &ctx,
                plan["backupId"]
                    .as_str()
                    .ok_or_else(|| Error::journal("恢复计划缺少备份"))?,
                plan["backupSha256"].as_str(),
            )?;
            let targets = entries
                .iter()
                .map(|entry| {
                    entry["source"]
                        .as_str()
                        .map(PathBuf::from)
                        .ok_or_else(|| Error::path("恢复目标无效"))
                })
                .collect::<Result<Vec<_>>>()?;
            let saved = backup::save(&ctx, &backup::capture(&ctx, &targets)?, "pre-recovery")?;
            claim.update(json!({"phase":"recovering","recovery":{"pid":std::process::id(),"nonce":claim.nonce,"undo":{"id":saved.id,"sha256":saved.hash}}}))?;
            undo = Some(saved);
            for (index, item) in backup.entries.iter().enumerate() {
                claim.owned()?;
                if !codec::equal(
                    &fs::state(&Context::new(options)?.target(&item.file)?)?,
                    &entries[index]["current"],
                ) {
                    return Err(Error::conflict("恢复过程中目标发生冲突"));
                }
                attempted.push(index);
                backup::restore(&ctx, std::slice::from_ref(item), || {
                    claim.owned().map(|_| ())
                })?;
            }
            for item in &backup.entries {
                if !codec::equal(&fs::state(&item.file)?, &item.expected) {
                    return Err(Error::new(
                        409,
                        "MAINTENANCE_INCONSISTENT",
                        "恢复后全量字节核验失败",
                    ));
                }
            }
        }
        let mut final_state = Vec::new();
        for entry in entries {
            let file = Path::new(entry["source"].as_str().unwrap());
            let mut value = fs::state(file)?;
            value["source"] = entry["source"].clone();
            final_state.push(value);
        }
        claim.update(json!({"phase":"recovered","noMutation":plan["backupId"].is_null(),"final":final_state}))?;
        claim.release()?;
        Ok(
            json!({"ok":true,"dataIntegrity":"restored","transactionId":plan["transactionId"],"action":plan["action"],"undoBackup":undo.as_ref().map(|backup|&backup.id),"restoredFiles":if plan["action"]=="restore"{entries.len()}else{0}}),
        )
    })();
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut errors = Vec::new();
            if let Some(undo) = &undo {
                for index in attempted.into_iter().rev() {
                    if let Err(error) =
                        backup::restore(&ctx, std::slice::from_ref(&undo.entries[index]), || {
                            claim.owned().map(|_| ())
                        })
                    {
                        errors.push(error.message);
                    }
                }
                for entry in &undo.entries {
                    match fs::state(&entry.file) {
                        Ok(state) if codec::equal(&state, &entry.expected) => {}
                        Ok(_) => errors.push(format!("恢复前字节未还原：{}", entry.file.display())),
                        Err(error) => errors.push(error.message),
                    }
                }
                if let Err(error)=claim.update(json!({"phase":if errors.is_empty(){"recovery-failed"}else{"INCONSISTENT"},"recovery":{"pid":std::process::id(),"nonce":claim.nonce,"undo":{"id":undo.id,"sha256":undo.hash},"error":error.message,"rollback":if errors.is_empty(){"pre-recovery-restored"}else{"INCONSISTENT"},"rollbackErrors":errors}})){errors.push(error.message);}
            }
            if let Err(error) = claim.finish() {
                errors.push(error.message);
            }
            Ok(
                json!({"ok":false,"code":error.code,"error":error.message,"rolledBack":errors.is_empty(),"dataIntegrity":if errors.is_empty(){"pre-recovery-restored"}else{"INCONSISTENT"},"recoveryRequired":true,"undoBackup":undo.as_ref().map(|backup|&backup.id),"rollbackErrors":errors}),
            )
        }
    }
}
