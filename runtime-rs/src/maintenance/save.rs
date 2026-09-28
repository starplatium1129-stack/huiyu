mod input;
#[cfg(test)]
mod tests;
use super::{
    Error, Options, Result, blueprints, fs, journal, prompt, scenes, semantics, state,
    transaction::Transaction, validation,
};
pub(super) use input::prepare;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub(super) fn check(cancel: &CancellationToken, started: Instant) -> Result<()> {
    if cancel.is_cancelled() {
        Err(Error::new(499, "ABORT_ERR", "维护保存已取消"))
    } else if started.elapsed() > Duration::from_secs(120) {
        Err(Error::new(504, "MAINTENANCE_TIMEOUT", "维护保存超时"))
    } else {
        Ok(())
    }
}
pub(super) fn issues(stage: &str, issues: Vec<String>) -> Result<()> {
    if issues.is_empty() {
        Ok(())
    } else {
        let mut error = Error::invalid(issues.join("\n"));
        error.extra = json!({"stage":stage,"issues":issues}).into();
        Err(error)
    }
}
pub(super) fn execute(
    options: &Options,
    body: &Value,
    import: bool,
    cancel: &CancellationToken,
) -> Result<Value> {
    let started = Instant::now();
    check(cancel, started)?;
    let prepared = prepare(options, body, import)?;
    // Plan all normalizer additions before the backup is sealed, including a
    // newly created overflow batch. Runtime never delegates to a Node process.
    let initial = scenes::plan(&prepared.state, &prepared.scenes)?;
    let mut staged = initial.staged(&prepared.state);
    let pins = fs::json(&options.root.join("data/prompt-pinned-scenes.json"))?;
    staged
        .retired
        .extend(prompt::strings(&initial.changes["removedIds"]));
    if !pins["scenes"].is_object() {
        return Err(Error::invalid("Invalid pinned scenes"));
    }
    let classified = prompt::classify(
        staged.value["snapshot"]["scenes"].as_array().unwrap(),
        &pins["scenes"],
    )?;
    let classify = scenes::plan(&staged, &classified)?;
    let staged = classify.staged(&staged);
    let optimized = staged.value["snapshot"]["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|scene| prompt::optimize(scene, &pins["scenes"]))
        .collect::<Vec<_>>();
    issues(
        "optimize-scenes",
        semantics::optimizer_issues(&optimized, &pins["scenes"]),
    )?;
    let optimize = scenes::plan(&staged, &optimized)?;
    validation::protect_pins(
        &options.root,
        prepared.state.value["snapshot"]["scenes"]
            .as_array()
            .unwrap(),
        &optimized,
    )?;
    let mut targets = scenes::snapshot_targets(
        options,
        &initial,
        &prompt::strings(&initial.changes["removedIds"]),
    )?;
    targets.extend(classify.targets(&options.root));
    targets.extend(optimize.targets(&options.root));
    if let Some(blueprints) = &prepared.blueprints {
        targets.extend(blueprints.targets());
    }
    let targets = scenes::compressed_targets(&targets)?;
    check(cancel, started)?;
    let mut transaction = Transaction::acquire(options)?;
    let outcome = (|| {
        if prepared.version != state::version(&options.root)? {
            return Err(Error::conflict("获取保存锁后基线已变化，请重新读取"));
        }
        let backup = transaction.prepare(
            &targets,
            if prepared.blueprints.is_some() {
                "content-blueprints"
            } else {
                "content"
            },
        )?;
        if prepared.version != state::version(&options.root)? {
            return Err(Error::conflict("准备保存时内容发生变化，请重新读取"));
        }
        check(cancel, started)?;
        initial.apply(&options.root, &transaction)?;
        scenes::aggregate(&options.root, &prepared.scenes, &transaction)?;
        for (name, value) in [
            ("tags.json", &prepared.tags),
            ("curation.json", &prepared.curation),
        ] {
            if let Some(value) = value {
                transaction.write(
                    &options.root.join("data").join(name),
                    blueprints::json_text(value).as_bytes(),
                )?;
            }
        }
        if let Some(blueprints) = &prepared.blueprints {
            blueprints.apply(&transaction)?;
        }
        check(cancel, started)?;
        scenes::retire(
            options,
            prepared.state.value["snapshot"]["scenes"]
                .as_array()
                .unwrap(),
            &prepared.scenes,
            &transaction,
        )?;
        scenes::clean_refs(&options.root, &prepared.scenes, &transaction)?;
        classify.apply(&options.root, &transaction)?;
        scenes::aggregate(&options.root, &classified, &transaction)?;
        check(cancel, started)?;
        optimize.apply(&options.root, &transaction)?;
        scenes::aggregate(&options.root, &optimized, &transaction)?;
        issues(
            "validate-scenes",
            semantics::validate(&options.root, &optimized),
        )?;
        check(cancel, started)?;
        scenes::refresh_compressed(&targets, &transaction)?;
        scenes::sync_version(&options.root)?;
        if prepared.blueprints.is_some() {
            super::contracts::validate(options)?;
        }
        let saved = state::read_transaction(options, &transaction)?;
        validation::protect_pins(
            &options.root,
            prepared.state.value["snapshot"]["scenes"]
                .as_array()
                .unwrap(),
            saved.value["snapshot"]["scenes"].as_array().unwrap(),
        )?;
        check(cancel, started)?;
        transaction.commit()?;
        let mut value = json!({"ok":true,"count":saved.value["snapshot"]["scenes"].as_array().unwrap().len(),"version":saved.value["version"],"snapshot":saved.value["snapshot"],"backup":backup,"added":initial.changes["addedIds"],"updated":initial.changes["updatedIds"],"removed":initial.changes["removedIds"],"submission":if import{"import"}else{"changes"},"message":"内容已保存并通过校验"});
        if let Some(tags) = &prepared.tags {
            value["tagCount"] = tags.as_array().unwrap().len().into();
        }
        if prepared.blueprints.is_some() {
            value["blueprintCount"] = saved.value["snapshot"]["blueprints"]
                .as_array()
                .unwrap()
                .len()
                .into();
        }
        Ok(value)
    })();
    outcome.map_err(|error| rollback_error(&mut transaction, error))
}
pub(super) fn rollback_error(transaction: &mut Transaction, mut error: Error) -> Error {
    let rollback = transaction.rollback();
    let restored = rollback.is_ok();
    error.extra.as_object_mut().unwrap().extend(json!({"rolledBack":restored,"dataIntegrity":if restored{"restored"}else{"INCONSISTENT"},"recoveryRequired":!restored,"transactionId":transaction.nonce}).as_object().unwrap().clone());
    if let Err(rollback) = rollback {
        error.status = axum::http::StatusCode::INTERNAL_SERVER_ERROR;
        error.extra["recovery"] = format!(
            "维护事务尚未完整结束，请先使用恢复工具核验。{}",
            rollback.message
        )
        .into();
    }
    error
}
