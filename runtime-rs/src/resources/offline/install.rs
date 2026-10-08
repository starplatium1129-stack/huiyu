use super::{
    Error, Options, Result, Value, config, fs, json, paths::Paths, release::Release, showcase,
};
use crate::resources::{
    equal,
    lifecycle::{self, Operation},
    state,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn configuration(options: &Options, paths: &Paths, release: &Release) -> Result<Value> {
    let mut value = fs::json(&paths.policy, true, false)?.unwrap_or_else(|| json!({"userDataRoot":paths.user,"protectedRoots":[],"policy":{"sources":{},"releases":{}}}));
    if value["userDataRoot"] != paths.user.to_string_lossy().as_ref()
        || !value["protectedRoots"].is_array()
        || !value["policy"]["sources"].is_object()
        || !value["policy"]["releases"].is_object()
    {
        return Err(Error::new(
            "CONFIG_REQUIRED",
            "Existing offline configuration does not belong to this user resource root",
        ));
    }
    if let Some(previous) = value["policy"]["releases"].get(&release.id)
        && (previous["releaseSha256"] != options.expected
            || previous["packageIdentity"] != release.approved["packageIdentity"]
            || previous["targetIdentity"] != release.approved["targetIdentity"])
    {
        return Err(Error::new(
            "APPROVAL_REQUIRED",
            "An approved release ID cannot be rebound to different bytes",
        ));
    }
    let roots = value["protectedRoots"].as_array_mut().unwrap();
    for root in [&options.app, &options.runtime.join("outputs")] {
        let root = json!(root);
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    value["policy"]["sources"][&release.id] = json!({"approved":true,"kind":"offline","root":options.package,"approvalSha256":options.expected});
    value["policy"]["releases"][&release.id] = release.approved.clone();
    Ok(value)
}
fn pending(options: &Options, paths: &Paths, release: &Release) -> Result<Option<Value>> {
    let Some(value) = fs::json(&paths.pending, true, false)? else {
        return Ok(None);
    };
    let name = value["target"]["path"].as_str().unwrap_or("");
    if value["schemaVersion"] != 1
        || value["kind"] != "huiyu-offline-import"
        || value["releaseSha256"] != options.expected
        || value["releaseId"] != release.id
        || value["target"]["releaseSha256"] != options.expected
        || value["target"]["contentIdentity"] != release.showcase.identity()
        || !name
            .strip_prefix("editions/")
            .is_some_and(|tail| tail.len() == 36 && uuid::Uuid::parse_str(tail).is_ok())
        || !matches!(
            value["phase"].as_str(),
            Some("preparing" | "showcase-prepared" | "assets-installed" | "committed")
        )
    {
        return Err(Error::new(
            "PENDING_TRANSACTION",
            "Recover the previously approved offline package before importing another release",
        ));
    }
    let current = paths.pointer()?;
    super::paths::validate_pointer(&value["beforeShowcase"])?;
    if value["beforeResource"]["schemaVersion"] != 1
        || crate::resources::number(&value["beforeResource"]["sequence"]).is_none()
        || value["beforeResource"].get("current").is_none()
        || value["beforeResource"].get("previous").is_none()
    {
        return Err(Error::new(
            "STATE_INVALID",
            "Invalid offline recovery asset baseline",
        ));
    }
    if !equal(&current, &value["beforeShowcase"])
        && !(current["current"] == value["target"] && value["phase"] == "committed")
    {
        return Err(Error::new(
            "STATE_CONFLICT",
            "Showcase pointer changed after interrupted import",
        ));
    }
    Ok(Some(value))
}
fn incremental_baseline(
    options: &Options,
    paths: &Paths,
    release: &Release,
    cancel: &CancellationToken,
) -> Result<()> {
    let Some(base) = &release.baseline else {
        return Ok(());
    };
    showcase::baseline(paths, release)?;
    if paths.pointer()?["current"]["releaseSha256"] == options.expected {
        return Ok(());
    }
    if !paths.policy.is_file() {
        return Err(Error::new(
            "BASELINE_REQUIRED",
            "增量包需要已安装的基础资源库。",
        ));
    }
    let ctx = config::load(&options.gateway(), &paths.policy, cancel.clone())?.ctx;
    if state::read(&ctx)?["current"]["identity"] != base["resourceIdentity"] {
        return Err(Error::new(
            "BASELINE_MISMATCH",
            "增量包与本机基础资源版本不匹配，请使用匹配的增量包或完整包。",
        ));
    }
    Ok(())
}
pub(super) fn preview(
    options: &Options,
    paths: &Paths,
    release: &Release,
    cancel: &CancellationToken,
) -> Result<Value> {
    configuration(options, paths, release)?;
    let transaction = pending(options, paths, release)?;
    if transaction.is_none() {
        incremental_baseline(options, paths, release, cancel)?;
    }
    let pointer = paths.pointer()?;
    let current_root = paths.current_root(&pointer)?;
    // Pending recovery verifies its prepared target; a damaged old sample must
    // not prevent resuming a healthy edition that was already copied.
    if transaction.is_none()
        && let Some(root) = current_root
    {
        showcase::verify_current(&root, cancel)?;
    }
    let mut installed = Value::Null;
    if paths.policy.exists() && transaction.is_none() {
        let context = config::load(&options.gateway(), &paths.policy, cancel.clone())?.ctx;
        let value = state::read(&context)?;
        if !value["current"].is_null() {
            state::verify(&context, &value["current"], cancel)?;
        }
        installed = value["current"].clone();
    }
    Ok(
        json!({"ok":true,"kind":"huiyu-offline-import-plan","apply":false,"releaseId":release.id,"appVersion":release.app_version,
        "releaseSha256":options.expected,"resourceFiles":release.assets.entries.len(),"resourceBytes":release.assets.bytes(),
        "showcaseFiles":release.showcase_payload.entries.len(),"showcaseBytes":release.showcase_payload.bytes(),"showcaseEntries":release.display["entries"].as_array().unwrap().len(),"mode":if release.baseline.is_some(){"delta"}else{"full"},"baseRelease":release.baseline,
        "userResourceRoot":paths.user,"showcaseLibraryRoot":paths.showcase,"configuration":paths.policy,
        "catalogIncluded":release.catalog.is_some(),"currentResource":installed,"currentShowcase":pointer["current"],"recoveryRequired":transaction.is_some(),"requiresDesktopClosed":true}),
    )
}
fn save(paths: &Paths, value: &mut Value, phase: &str) -> Result<()> {
    value["phase"] = phase.into();
    fs::write_json(&paths.pending, value)
}
pub(super) fn apply(
    options: &Options,
    paths: &Paths,
    release: &Release,
    cancel: &CancellationToken,
) -> Result<Value> {
    apply_with_progress(options, paths, release, cancel, Arc::new(|_| {}))
}
pub(super) fn apply_with_progress(
    options: &Options,
    paths: &Paths,
    release: &Release,
    cancel: &CancellationToken,
    progress: lifecycle::Progress,
) -> Result<Value> {
    let next_config = configuration(options, paths, release)?;
    let mut journal = pending(options, paths, release)?;
    if journal.is_none() {
        incremental_baseline(options, paths, release, cancel)?;
    }
    // Reject local content conflicts before activating resources or creating a
    // pending resource transaction. The runtime lease excludes other writers.
    let mut catalog = super::catalog::prepare(options, release)?;
    fs::ensure(&paths.user)?;
    showcase::initialize(paths)?;
    let context_file = options.runtime.join("offline-install-context.json");
    // Only the private transaction configuration sees new approval before commit.
    // Failure leaves the canonical policy's old approvals byte-for-byte intact.
    fs::write_json(&context_file, &next_config)?;
    // Operation cancellation must not revoke the stable approval context needed
    // to restore a verified previous pointer during rollback.
    let context = config::load(&options.gateway(), &context_file, CancellationToken::new())?.ctx;
    context.initialize()?;
    let op = Operation {
        ctx: context,
        cancel: cancel.clone(),
        progress,
    };
    let before_resource = state::read(&op.ctx)?;
    let before_showcase = paths.pointer()?;
    if journal.is_none()
        && before_showcase["current"]["releaseSha256"] == options.expected
        && before_resource["current"]["identity"] == release.approved["targetIdentity"]
    {
        state::verify(&op.ctx, &before_resource["current"], cancel)?;
        if let Some(root) = paths.current_root(&before_showcase)? {
            showcase::verify_current(&root, cancel)?;
        }
        fs::remove(&context_file)?;
        let catalog = super::catalog::apply(options, release, &mut catalog)?;
        return Ok(
            json!({"ok":true,"kind":"huiyu-offline-import-result","action":"already-installed","releaseId":release.id,"releaseSha256":options.expected,"catalog":catalog,"restartRequired":true}),
        );
    }
    if journal.is_none() {
        let target = json!({"path":format!("editions/{}", uuid::Uuid::new_v4()),"releaseSha256":options.expected,"contentIdentity":release.showcase.identity()});
        let mut value = json!({"schemaVersion":1,"kind":"huiyu-offline-import","releaseId":release.id,"releaseSha256":options.expected,
            "beforeShowcase":before_showcase,"beforeResource":before_resource,"target":target,"phase":"preparing"});
        save(paths, &mut value, "preparing")?;
        journal = Some(value);
    }
    let mut journal = journal.unwrap();
    state::validate(&op.ctx, &journal["beforeResource"])?;
    let recovered = journal["phase"] != "preparing";
    let root = fs::child(&paths.showcase, journal["target"]["path"].as_str().unwrap())?;
    let ready = showcase::prepare(
        &op,
        paths,
        &journal["beforeShowcase"],
        &journal["target"],
        release,
    )?;
    if journal["phase"] != "committed" {
        save(paths, &mut journal, "showcase-prepared")?;
    }
    let result = (|| {
        lifecycle::run(&op, "import", &release.id)?;
        if journal["phase"] != "committed" {
            save(paths, &mut journal, "assets-installed")?;
        }
        state::verify(&op.ctx, &state::read(&op.ctx)?["current"], cancel)?;
        showcase::verify_ready(&op, &root, release)?;
        op.check()?;
        let pointer = json!({"schemaVersion":1,"kind":"huiyu-showcase-current","current":journal["target"],"previous":journal["beforeShowcase"]["current"]});
        // Mark intent first. Recovery accepts either the old or the new pointer.
        save(paths, &mut journal, "committed")?;
        fs::write_json(&paths.showcase.join("active.json"), &pointer)?;
        fs::write_json(&paths.policy, &next_config)?;
        op.check()?;
        let catalog = super::catalog::apply(options, release, &mut catalog)?;
        fs::remove(&context_file)?;
        fs::remove(&paths.pending)?;
        Ok(
            json!({"ok":true,"kind":"huiyu-offline-import-result","action":if recovered{"recovered"}else{"installed"},"releaseId":release.id,
            "releaseSha256":options.expected,"resources":{"files":release.assets.entries.len(),"identity":release.assets.identity()},
            "showcase":{"entries":release.display["entries"].as_array().unwrap().len(),"root":root,"preservedLocalEntries":ready["preservedLocalEntries"]},"catalog":catalog,"restartRequired":true}),
        )
    })();
    if result.is_err()
        && journal["phase"] != "committed"
        && state::read(&op.ctx)?.get("current") != journal["beforeResource"].get("current")
    {
        // A prepared version stays available for recovery, while failure retains
        // the previous working asset pointer and all of its independent approvals.
        if !journal["beforeResource"]["current"].is_null() {
            state::verify(
                &op.ctx,
                &journal["beforeResource"]["current"],
                &CancellationToken::new(),
            )?;
        }
        fs::write_json(
            &op.ctx.store.join("current.json"),
            &journal["beforeResource"],
        )?;
    }
    result
}
