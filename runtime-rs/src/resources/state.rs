use super::{
    Error, Result, Value,
    config::Context,
    equal, fs, json,
    manifest::{self, Manifest},
    number, policy,
};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;
pub(super) fn empty() -> Value {
    json!({"schemaVersion":1,"sequence":0,"current":null,"previous":null})
}
pub(super) fn validate(ctx: &Context, value: &Value) -> Result<()> {
    if value["schemaVersion"] != 1
        || number(&value["sequence"]).is_none()
        || value.get("current").is_none()
        || value.get("previous").is_none()
    {
        return Err(Error::new("STATE_INVALID", "Malformed installed state"));
    }
    for key in ["current", "previous"] {
        if !value[key].is_null() {
            policy::validate_reference(ctx, &value[key])?;
        }
    }
    Ok(())
}
pub(super) fn read(ctx: &Context) -> Result<Value> {
    let value = fs::json(&ctx.store.join("current.json"), true, false)?.unwrap_or_else(empty);
    validate(ctx, &value)?;
    Ok(value)
}
pub(super) fn version_root(ctx: &Context, reference: &Value) -> Result<PathBuf> {
    policy::validate_reference(ctx, reference)?;
    fs::child(
        &ctx.store,
        &format!("versions/{}", reference["identity"].as_str().unwrap()),
    )
}
pub(super) struct Version {
    pub root: PathBuf,
    pub manifest: Manifest,
    pub reference: Value,
}
pub(super) fn verify(
    ctx: &Context,
    reference: &Value,
    cancel: &CancellationToken,
) -> Result<Version> {
    let root = version_root(ctx, reference)?;
    let manifest = Manifest::parse(&fs::json(&root.join("manifest.json"), false, false)?.unwrap())?;
    if manifest.identity() != reference["identity"] {
        return Err(Error::new(
            "INSTALLED_TAMPERED",
            "Installed manifest identity differs",
        ));
    }
    if !equal(
        &fs::json(&root.join("receipt.json"), false, false)?.unwrap(),
        &json!({"schemaVersion":1,"reference":reference}),
    ) {
        return Err(Error::new(
            "INSTALLED_TAMPERED",
            "Installed receipt invalid",
        ));
    }
    manifest::verify(&root, &manifest, &["manifest.json", "receipt.json"], cancel)?;
    Ok(Version {
        root,
        manifest,
        reference: reference.clone(),
    })
}
pub(super) fn existing(
    ctx: &Context,
    identity: &str,
    cancel: &CancellationToken,
) -> Result<Option<Version>> {
    let root = fs::child(&ctx.store, &format!("versions/{identity}"))?;
    if fs::safe(&root, true, false)?.is_none() {
        return Ok(None);
    }
    let receipt = fs::json(&root.join("receipt.json"), false, false)?.unwrap();
    if receipt["reference"]["identity"] != identity {
        return Err(Error::new("INSTALLED_TAMPERED", "Existing receipt invalid"));
    }
    verify(ctx, &receipt["reference"], cancel).map(Some)
}
pub(super) fn next(journal: &Value) -> Value {
    json!({"schemaVersion":1,"sequence":number(&journal["before"]["sequence"]).unwrap()+1,"current":journal["target"],"previous":journal["before"]["current"]})
}
pub(super) fn journal(ctx: &Context) -> Result<Option<Value>> {
    let Some(value) = fs::json(&ctx.store.join("pending.json"), true, false)? else {
        return Ok(None);
    };
    if value["schemaVersion"] != 1
        || value["id"].as_str().is_none_or(|id| {
            id.len() != 36
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        })
        || !matches!(value["kind"].as_str(), Some("install" | "rollback"))
        || !matches!(value["phase"].as_str(), Some("copying" | "prepared"))
    {
        return Err(Error::new("JOURNAL_INVALID", "Malformed recovery journal"));
    }
    validate(ctx, &value["before"])?;
    policy::validate_reference(ctx, &value["target"])?;
    if number(&value["before"]["sequence"]) == Some(9_007_199_254_740_991) {
        return Err(Error::new("JOURNAL_INVALID", "State sequence overflow"));
    }
    Ok(Some(value))
}
