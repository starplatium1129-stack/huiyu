use super::{
    Error, Options, Result, fs, prompt, scenes, semantics, state, transaction::Transaction,
    validation,
};
use serde_json::{Value, json};
use std::time::Instant;
use tokio_util::sync::CancellationToken;
pub(super) fn run(options: &Options, body: &Value, cancel: &CancellationToken) -> Result<Value> {
    let task = prompt::text(&body["task"]);
    let task = prompt::trim(&task);
    let label = match task {
        "validate" => "完整场景校验",
        "classify" => "更新场景评级",
        "optimize" => "规范化提示词",
        "lint-colors" => "检查硬编码颜色",
        _ => return Err(Error::invalid(format!("不支持的任务：{task}"))),
    };
    let started = Instant::now();
    super::save::check(cancel, started)?;
    let current = state::read(options)?;
    let version = current.value["version"].as_u64().unwrap();
    let before = current.value["snapshot"]["scenes"].as_array().unwrap();
    let pins = fs::json(&options.root.join("data/prompt-pinned-scenes.json"))?;
    let next = match task {
        "classify" => prompt::classify(before, &pins["scenes"])?,
        "optimize" => before
            .iter()
            .map(|scene| prompt::optimize(scene, &pins["scenes"]))
            .collect(),
        _ => before.clone(),
    };
    let plan = scenes::plan(&current, &next)?;
    let targets = scenes::compressed_targets(&scenes::snapshot_targets(options, &plan, &[])?)?;
    let mut transaction = Transaction::acquire(options)?;
    let result = (|| {
        if version != state::version(&options.root)? {
            return Err(Error::conflict("获取维护锁后内容已变化，请重新读取"));
        }
        transaction.prepare(&targets, &format!("maintenance-{task}"))?;
        super::save::check(cancel, started)?;
        let output = if task == "lint-colors" {
            super::colors::report(&options.root, cancel)?
        } else if task == "validate" {
            super::save::issues(
                "validate-scenes",
                semantics::validate(&options.root, before),
            )?;
            let presets = fs::json(&options.root.join("data/presets.json"))?;
            format!(
                "Validation passed: {} scenes, {} model profiles, {} presets",
                before.len(),
                presets["model_profiles"]
                    .as_array()
                    .map(Vec::len)
                    .unwrap_or(0),
                presets["presets"].as_array().map(Vec::len).unwrap_or(0)
            )
        } else {
            if task == "optimize" {
                super::save::issues(
                    "optimize-scenes",
                    semantics::optimizer_issues(&next, &pins["scenes"]),
                )?;
            }
            plan.apply(&options.root, &transaction)?;
            scenes::aggregate(&options.root, &next, &transaction)?;
            super::save::check(cancel, started)?;
            scenes::refresh_compressed(&targets, &transaction)?;
            scenes::sync_version(&options.root)?;
            let changed = next
                .iter()
                .filter(|scene| {
                    before.iter().any(|old| {
                        old["id"] == scene["id"]
                            && crate::storage::stringify(old) != crate::storage::stringify(scene)
                    })
                })
                .count();
            if task == "optimize" {
                format!("scenes={} changed={changed} issues=0", next.len())
            } else {
                format!(
                    "ratings: All={} R15={} R18={} changed={changed} written",
                    next.iter().filter(|scene| scene["rating"] == "All").count(),
                    next.iter().filter(|scene| scene["rating"] == "R15").count(),
                    next.iter().filter(|scene| scene["rating"] == "R18").count()
                )
            }
        };
        validation::protect_pins(&options.root, before, &next)?;
        super::save::check(cancel, started)?;
        transaction.commit()?;
        Ok(json!({"ok":true,"task":task,"label":label,"output":output,"exitCode":0}))
    })();
    result.map_err(|error| {
        let mut error = super::save::rollback_error(&mut transaction, error);
        error.extra["task"] = task.into();
        error.extra["label"] = label.into();
        error.extra["output"] = format!("执行出错：{}", error.message).into();
        error.extra["exitCode"] = 1.into();
        error
    })
}
