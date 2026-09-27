mod copy;
use super::{
    Error, Result, Value,
    config::{Context, cancelled},
    equal, fs, json, lease, manifest, policy, state,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
pub(super) type Progress = Arc<dyn Fn(Value) + Send + Sync>;
#[derive(Clone)]
pub(super) struct Operation {
    pub ctx: Context,
    pub cancel: CancellationToken,
    pub progress: Progress,
}
impl Operation {
    pub fn check(&self) -> Result<()> {
        cancelled(&self.cancel)?;
        self.ctx.access()
    }
    pub fn event(&self, phase: &str, details: Value) -> Result<()> {
        self.check()?;
        let mut value = details;
        value["phase"] = phase.into();
        (self.progress)(value);
        std::thread::yield_now();
        cancelled(&self.cancel)
    }
}
fn save(ctx: &Context, journal: &Value) -> Result<()> {
    fs::write_json(&ctx.store.join("pending.json"), journal)
}
fn forget(ctx: &Context) -> Result<()> {
    fs::remove(&ctx.store.join("pending.json"))
}
fn before(op: &Operation, journal: &Value) -> Result<()> {
    if !journal["before"]["current"].is_null() {
        state::verify(&op.ctx, &journal["before"]["current"], &op.cancel)?;
    }
    Ok(())
}
fn result(state: Value, action: &str) -> Value {
    json!({"ok":true,"kind":"resource-install-result","action":action,"state":state})
}
fn quarantine(op: &Operation, journal: &Value) -> Result<()> {
    if journal["kind"] != "install"
        || ["current", "previous"]
            .iter()
            .any(|key| journal["before"][*key]["identity"] == journal["target"]["identity"])
    {
        return Ok(());
    }
    let target = state::version_root(&op.ctx, &journal["target"])?;
    if fs::safe(&target, true, false)?.is_none() {
        return Ok(());
    }
    if !equal(
        &fs::json(&target.join("receipt.json"), false, false)?.unwrap(),
        &json!({"schemaVersion":1,"reference":journal["target"]}),
    ) {
        return Err(Error::new(
            "INSTALLED_TAMPERED",
            "Cannot quarantine unknown-owned target",
        ));
    }
    let transaction = fs::child(
        &op.ctx.store,
        &format!("transactions/{}", journal["id"].as_str().unwrap()),
    )?;
    fs::ensure(&transaction)?;
    let rejected = transaction.join(format!("rejected-{}", uuid::Uuid::new_v4()));
    fs::safe(&target, false, false)?;
    std::fs::rename(target, rejected)?;
    fs::sync(&transaction)
}
fn interrupted(op: &Operation, journal: &Value, state: &Value) -> Result<Option<Value>> {
    if !equal(state, &state::next(journal)) {
        return Ok(None);
    }
    if let Err(error) = state::verify(&op.ctx, &journal["target"], &op.cancel) {
        cancelled(&op.cancel)?;
        before(op, journal)?;
        fs::write_json(&op.ctx.store.join("current.json"), &journal["before"])?;
        quarantine(op, journal)?;
        forget(&op.ctx)?;
        let mut output = result(journal["before"].clone(), "rolled-back");
        output["cause"] = json!({"code":error.code,"message":error.message});
        return Ok(Some(output));
    }
    forget(&op.ctx)?;
    Ok(Some(result(state.clone(), "recovered")))
}
fn commit(op: &Operation, journal: &Value) -> Result<Value> {
    op.check()?;
    let state = state::read(&op.ctx)?;
    if !equal(&state, &journal["before"]) {
        return Err(Error::new(
            "STATE_CONFLICT",
            "Installed state changed during transaction",
        ));
    }
    state::verify(&op.ctx, &journal["target"], &op.cancel)?;
    let next = state::next(journal);
    let outcome = (|| {
        fs::space(&op.ctx.store, 65536)?;
        fs::write_json(&op.ctx.store.join("current.json"), &next)?;
        op.event(
            "switched",
            json!({"identity":journal["target"]["identity"]}),
        )?;
        op.ctx.access()?;
        state::verify(&op.ctx, &journal["target"], &op.cancel)?;
        cancelled(&op.cancel)?;
        forget(&op.ctx)?;
        Ok(result(
            next.clone(),
            if journal["kind"] == "rollback" {
                "rolled-back"
            } else {
                "installed"
            },
        ))
    })();
    if outcome.is_err() && equal(&state::read(&op.ctx)?, &next) {
        // Cancellation must not prevent restoring a verified previous pointer.
        let rollback = Operation {
            cancel: CancellationToken::new(),
            ..op.clone()
        };
        before(&rollback, journal)?;
        fs::write_json(&op.ctx.store.join("current.json"), &journal["before"])?;
    }
    outcome
}
fn install(op: &Operation, id: &str) -> Result<Value> {
    let ctx = &op.ctx;
    let release = policy::release(ctx, id)?;
    cancelled(&op.cancel)?;
    let mut journal = state::journal(ctx)?;
    let before_state = state::read(ctx)?;
    if let Some(journal) = journal.as_mut() {
        if journal["kind"] != "install"
            || journal["releaseId"] != id
            || journal["packageIdentity"] != release["packageIdentity"]
        {
            return Err(Error::new(
                "PENDING_TRANSACTION",
                "Recover existing transaction first",
            ));
        }
        if let Some(done) = interrupted(op, journal, &before_state)? {
            return Ok(done);
        }
        if !equal(&before_state, &journal["before"]) {
            return Err(Error::new("STATE_CONFLICT", "Journal baseline differs"));
        }
        if journal["target"]["identity"] != release["targetIdentity"] {
            return Err(Error::new(
                "JOURNAL_INVALID",
                "Journal target differs from approval",
            ));
        }
        let existing =
            match state::existing(ctx, release["targetIdentity"].as_str().unwrap(), &op.cancel) {
                Ok(existing) => existing,
                Err(error)
                    if ["CONTENT_INVALID", "INSTALLED_TAMPERED", "UNLISTED_FILE"]
                        .contains(&error.code.as_str()) =>
                {
                    quarantine(op, journal)?;
                    state::existing(ctx, release["targetIdentity"].as_str().unwrap(), &op.cancel)?
                }
                Err(error) => return Err(error),
            };
        if let Some(existing) = existing {
            before(op, journal)?;
            journal["target"] = existing.reference;
            journal["phase"] = "prepared".into();
            save(ctx, journal)?;
            return commit(op, journal);
        }
    }
    let installed = if before_state["current"].is_null() {
        None
    } else {
        Some(state::verify(ctx, &before_state["current"], &op.cancel)?)
    };
    let pack = policy::read_pack(ctx, &release, &op.cancel)?;
    if journal.is_none() && before_state["current"]["identity"] == release["targetIdentity"] {
        if let Some(delta) = &pack.delta {
            let identity = delta["baseManifest"]["contentIdentity"]
                .as_str()
                .filter(|value| super::hash(value))
                .ok_or_else(|| Error::new("BASELINE_MISMATCH", "Invalid baseline identity"))?;
            let base = state::existing(ctx, identity, &op.cancel)?;
            policy::target(&pack, base.as_ref().map(|base| &base.manifest), &release)?;
        }
        return Ok(result(before_state, "already-installed"));
    }
    let target = policy::target(
        &pack,
        installed.as_ref().map(|base| &base.manifest),
        &release,
    )?;
    if journal.is_none() {
        if super::number(&before_state["sequence"]) == Some(9_007_199_254_740_991) {
            return Err(Error::new("JOURNAL_INVALID", "Sequence exhausted"));
        }
        let existing =
            state::existing(ctx, release["targetIdentity"].as_str().unwrap(), &op.cancel)?;
        let mut value = json!({"schemaVersion":1,"id":uuid::Uuid::new_v4().to_string(),"kind":"install","phase":"copying","releaseId":id,"packageIdentity":release["packageIdentity"],"before":before_state,"target":existing.as_ref().map(|value|value.reference.clone()).unwrap_or_else(||policy::reference(&release))});
        fs::space(&ctx.store, 65536)?;
        save(ctx, &value)?;
        op.event("journal", json!({"id":value["id"]}))?;
        if existing.is_some() {
            value["phase"] = "prepared".into();
            save(ctx, &value)?;
            return commit(op, &value);
        }
        journal = Some(value);
    }
    let mut journal = journal.unwrap();
    let transaction = fs::child(
        &ctx.store,
        &format!("transactions/{}", journal["id"].as_str().unwrap()),
    )?;
    let tree = transaction.join("tree");
    let parts = transaction.join("parts");
    fs::ensure(&tree)?;
    fs::clean_temps(&tree, &["manifest.json", "receipt.json"])?;
    let mut remaining = crate::storage::stringify(&target.value()).len() as u64 + 65536;
    for entry in &target.entries {
        if !fs::file_matches(&fs::child(&tree, &entry.path)?, entry, &op.cancel)? {
            remaining = remaining
                .checked_add(entry.bytes)
                .filter(|v| *v <= 9_007_199_254_740_991)
                .ok_or_else(|| Error::new("SIZE_INVALID", "Required byte total too large"))?;
        }
    }
    fs::space(&ctx.store, remaining)?;
    let candidates = pack
        .manifest
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<std::collections::HashSet<_>>();
    for entry in &target.entries {
        op.check()?;
        let source = if candidates.contains(entry.path.as_str()) {
            &pack.root
        } else {
            &installed
                .as_ref()
                .ok_or_else(|| Error::new("BASELINE_REQUIRED", "Missing installed baseline"))?
                .root
        };
        copy::entry(op, source, &tree, &parts, entry)?;
    }
    fs::write_json(&tree.join("manifest.json"), &target.value())?;
    fs::write_json(
        &tree.join("receipt.json"),
        &json!({"schemaVersion":1,"reference":journal["target"]}),
    )?;
    manifest::verify(
        &tree,
        &target,
        &["manifest.json", "receipt.json"],
        &op.cancel,
    )?;
    op.event("staged", json!({"identity":journal["target"]["identity"]}))?;
    let versions = ctx.store.join("versions");
    fs::ensure(&versions)?;
    let destination = fs::child(&versions, journal["target"]["identity"].as_str().unwrap())?;
    if fs::safe(&destination, true, false)?.is_some() {
        return Err(Error::new(
            "TARGET_EXISTS",
            "Target appeared during install",
        ));
    }
    fs::safe(&tree, false, false)?;
    std::fs::rename(tree, destination)?;
    fs::sync(&versions)?;
    state::verify(ctx, &journal["target"], &op.cancel)?;
    journal["phase"] = "prepared".into();
    save(ctx, &journal)?;
    op.event(
        "prepared",
        json!({"identity":journal["target"]["identity"]}),
    )?;
    commit(op, &journal)
}
pub(super) fn run(op: &Operation, action: &str, release: &str) -> Result<Value> {
    op.check()?;
    if action == "import" {
        policy::release(&op.ctx, release)?;
    }
    op.ctx.initialize()?;
    let _lock = lease::acquire(&op.ctx, "writer", 0)?;
    match action {
        "import" => install(op, release),
        "recover" => {
            let state = state::read(&op.ctx)?;
            if let Some(journal) = state::journal(&op.ctx)? {
                if let Some(done) = interrupted(op, &journal, &state)? {
                    return Ok(done);
                }
                if journal["kind"] == "install" {
                    install(op, journal["releaseId"].as_str().unwrap_or(""))
                } else {
                    commit(op, &journal)
                }
            } else {
                if !state["current"].is_null() {
                    state::verify(&op.ctx, &state["current"], &op.cancel)?;
                }
                Ok(result(state, "nothing-to-recover"))
            }
        }
        "rollback" => {
            if state::journal(&op.ctx)?.is_some() {
                return Err(Error::new(
                    "PENDING_TRANSACTION",
                    "Recover pending transaction first",
                ));
            }
            let before = state::read(&op.ctx)?;
            if before["previous"].is_null() {
                return Err(Error::new(
                    "NO_PREVIOUS_VERSION",
                    "No previous installation retained",
                ));
            }
            state::verify(&op.ctx, &before["previous"], &op.cancel)?;
            let journal = json!({"schemaVersion":1,"id":uuid::Uuid::new_v4().to_string(),"kind":"rollback","phase":"prepared","target":before["previous"],"before":before});
            save(&op.ctx, &journal)?;
            commit(op, &journal)
        }
        _ => Err(Error::new("USAGE", "Unknown installer action")),
    }
}
