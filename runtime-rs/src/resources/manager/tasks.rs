use super::*;
use crate::resources::{
    download, identifier, lease,
    lifecycle::{self, Operation},
    policy,
};
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
// Keep lifecycle details (state, paths, raw causes) inside the installer.
// Apply the same projection to persisted tasks before publishing status.
fn public_result(action: &Value, cause: &Value) -> Value {
    if !matches!(
        action.as_str(),
        Some(
            "installed"
                | "already-installed"
                | "recovered"
                | "rolled-back"
                | "nothing-to-recover"
                | "downloaded"
                | "already-downloaded"
        )
    ) {
        return Value::Null;
    }
    let warning = if action == "rolled-back" && !cause.is_null() {
        let mut issue = crate::resources::public(&Error::new(
            cause["code"].as_str().unwrap_or("RESOURCE_FAILED"),
            "",
        ));
        // The prior version has been verified and restored; the ordinary
        // CONTENT_INVALID message incorrectly claims bundled fallback here.
        if issue["code"] == "CONTENT_INVALID" {
            issue["message"] = "新版本资源内容校验失败。".into();
        }
        issue
    } else {
        Value::Null
    };
    json!({"action":action,"warning":warning})
}
pub(super) fn saved(ctx: &config::Context) -> Result<Option<Value>> {
    let Some(mut value) = fs::json(&ctx.store.join("gateway/task.json"), true, false)? else {
        return Ok(None);
    };
    let id = value["id"].as_str().unwrap_or("");
    if id.len() != 36
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        || !matches!(
            value["action"].as_str(),
            Some("import" | "download" | "recover" | "rollback")
        )
        || !matches!(
            value["state"].as_str(),
            Some("running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted")
        )
        || (!value["releaseId"].is_null() && !identifier(value["releaseId"].as_str().unwrap_or("")))
    {
        return Err(Error::new("STATE_INVALID", "Invalid resource task"));
    }
    let interrupted = matches!(value["state"].as_str(), Some("running" | "cancelling"));
    if interrupted {
        value["state"] = "interrupted".into();
        value["error"] = crate::resources::public(&Error::new("INTERRUPTED", ""));
    } else if !value["error"].is_null() {
        value["error"] = crate::resources::public(&Error::new(
            value["error"]["code"].as_str().unwrap_or("RESOURCE_FAILED"),
            "",
        ));
    }
    let resume = if matches!(value["resumeAction"].as_str(), Some("download" | "import")) {
        value["resumeAction"].clone()
    } else {
        Value::Null
    };
    let result = if value["state"] == "completed" {
        public_result(&value["result"]["action"], &value["result"]["warning"])
    } else {
        Value::Null
    };
    Ok(Some(
        json!({"id":value["id"],"action":value["action"],"releaseId":value["releaseId"],"resumeAction":resume,"state":value["state"],"phase":if interrupted{"interrupted"}else{"settled"},"bytes":0,"total":0,"startedAt":value["startedAt"].as_u64().unwrap_or(0),"finishedAt":value["finishedAt"].as_u64().unwrap_or(0),"error":value["error"],"result":result}),
    ))
}
pub(super) fn start(
    service: &Arc<Service>,
    action: &str,
    release: Option<&str>,
    admission: crate::host::OwnedWriteGuard,
) -> Result<Value> {
    if service.closed.load(Ordering::Acquire) {
        return Err(Error::new("ACCESS_DENIED", "Service closed"));
    }
    if !service.management {
        return Err(Error::new(
            "MANAGEMENT_DISABLED",
            "Operator must enable management",
        ));
    }
    let mut data = service.data.lock().unwrap();
    if service.closed.load(Ordering::Acquire) {
        return Err(Error::new("ACCESS_DENIED", "Service closed"));
    }
    if service.active.load(Ordering::Acquire) {
        return Err(Error::new("BUSY", "Resource task already active"));
    }
    if !matches!(action, "import" | "download" | "recover" | "rollback") {
        return Err(Error::new("USAGE", "Unknown action"));
    }
    service.refresh(&mut data);
    let configuration = data
        .config
        .clone()
        .ok_or_else(|| Error::new("CONFIG_REQUIRED", "Resource policy required"))?;
    let ctx = configuration.ctx.clone();
    let mut release = release.map(str::to_owned);
    let mut resume: Option<String> = None;
    if action == "recover"
        && data.task.as_ref().is_some_and(|task| {
            matches!(
                task["state"].as_str(),
                Some("interrupted" | "cancelled" | "failed")
            )
        })
        && fs::safe(&ctx.store.join("pending.json"), true, false)?.is_none()
    {
        let previous = data.task.as_ref().unwrap();
        for kind in ["download", "import"] {
            if previous["action"] == kind || previous["resumeAction"] == kind {
                resume = Some(kind.into());
                release = previous["releaseId"].as_str().map(str::to_owned);
                break;
            }
        }
    }
    if matches!(action, "import" | "download") || resume.is_some() {
        policy::release(&ctx, release.as_deref().unwrap_or(""))?;
    }
    // Admission commits after read-only checks. Close can signal while refresh
    // holds the lock; reject before creating a lease or writing task state.
    if service.closed.load(Ordering::Acquire) {
        return Err(Error::new("ACCESS_DENIED", "Service closed"));
    }
    ctx.initialize()?;
    let gate = lease::acquire(&ctx, "gateway", 0)?;
    fs::ensure(&ctx.store.join("gateway"))?;
    let task = json!({"id":uuid::Uuid::new_v4().to_string(),"action":action,"releaseId":release,"resumeAction":resume,"state":"running","phase":"checking","bytes":0,"total":0,"startedAt":now(),"finishedAt":0,"error":null,"result":null});
    fs::write_json(&ctx.store.join("gateway/task.json"), &task)?;
    let cancel = service.shutdown.child_token();
    let id = task["id"].as_str().unwrap().to_owned();
    data.task = Some(task.clone());
    data.snapshot = None;
    data.cancel = Some(cancel.clone());
    service.active.store(true, Ordering::Release);
    let owner = service.clone();
    let weak = Arc::downgrade(service);
    let progress_id = id.clone();
    let op = Operation {
        ctx: ctx.clone(),
        cancel: cancel.clone(),
        progress: Arc::new(move |event| {
            if let Some(service) = weak.upgrade() {
                let mut data = service.data.lock().unwrap();
                if let Some(task) = data.task.as_mut()
                    && task["id"] == progress_id
                {
                    task["phase"] = event["phase"].clone();
                    task["bytes"] = crate::resources::number(&event["bytes"])
                        .unwrap_or(0)
                        .into();
                    task["total"] = crate::resources::number(&event["total"])
                        .unwrap_or(0)
                        .into();
                }
            }
        }),
    };
    let action = resume.unwrap_or_else(|| action.into());
    let release = release.unwrap_or_default();
    service.workers.spawn(async move {
        let _admission = admission;
        let outcome = if action == "download" {
            download::run(op, owner.client.clone(), release).await
        } else {
            crate::resources::blocking(move || lifecycle::run(&op, &action, &release)).await
        };
        let finishing = owner.clone();
        let _ = crate::resources::blocking(move || {
            let mut data = finishing.data.lock().unwrap();
            if let Some(task) = data.task.as_mut()
                && task["id"] == id
            {
                task["state"] = if outcome.is_ok() {
                    "completed"
                } else if cancel.is_cancelled()
                    || outcome
                        .as_ref()
                        .err()
                        .is_some_and(|error| error.code == "CANCELLED")
                {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                task["error"] = match &outcome {
                    Ok(_) => Value::Null,
                    Err(error) => {
                        if task["state"] == "cancelled" {
                            crate::resources::public(&Error::new("CANCELLED", ""))
                        } else {
                            crate::resources::public(error)
                        }
                    }
                };
                task["result"] = match &outcome {
                    Ok(result) => public_result(&result["action"], &result["cause"]),
                    Err(_) => Value::Null,
                };
                task["finishedAt"] = now().into();
                task["phase"] = "settled".into();
                if let Err(error) = fs::write_json(&ctx.store.join("gateway/task.json"), task) {
                    task["state"] = "failed".into();
                    task["error"] = crate::resources::public(&error);
                }
            }
            if let Err(error) = gate.release() {
                data.issue = Some(crate::resources::public(&error));
            }
            drop(gate);
            data.cancel = None;
            finishing.active.store(false, Ordering::Release);
            if !finishing.closed.load(Ordering::Acquire) {
                finishing.refresh(&mut data);
            }
            Ok(())
        })
        .await;
    });
    // Keep admission and worker registration under the same lock close uses
    // to cancel the admitted task, so close cannot finish before registration.
    drop(data);
    Ok(task)
}
