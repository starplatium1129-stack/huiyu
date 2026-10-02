use super::{
    Error, Result, Value,
    config::Context,
    digest, fs, hash, identifier, json,
    manifest::{self, Manifest},
};
use crate::file_paths;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;
pub(super) fn release(ctx: &Context, id: &str) -> Result<Value> {
    ctx.access()?;
    if !identifier(id) {
        return Err(Error::new(
            "CONFIG_REQUIRED",
            "Configured release ID required",
        ));
    }
    let mut release = ctx.policy["releases"][id].clone();
    if release["approved"] != true
        || !hash(release["packageIdentity"].as_str().unwrap_or(""))
        || !hash(release["targetIdentity"].as_str().unwrap_or(""))
        || !matches!(release["kind"].as_str(), Some("full" | "delta"))
    {
        return Err(Error::new(
            "APPROVAL_REQUIRED",
            "Independent approval and pinned identities required",
        ));
    }
    let source_id = release["sourceId"]
        .as_str()
        .filter(|id| identifier(id))
        .ok_or_else(|| Error::new("SOURCE_REQUIRED", "Configured source ID required"))?;
    let source = &ctx.policy["sources"][source_id];
    if source["approved"] != true || !matches!(source["kind"].as_str(), Some("offline" | "http")) {
        return Err(Error::new("SOURCE_REQUIRED", "Approved source required"));
    }
    fs::relative(
        release["path"]
            .as_str()
            .ok_or_else(|| Error::new("UNSAFE_PATH", "Release path required"))?,
    )?;
    if source["kind"] == "offline"
        && source["root"]
            .as_str()
            .is_none_or(|root| !std::path::Path::new(root).is_absolute())
    {
        return Err(Error::new(
            "SOURCE_REQUIRED",
            "Absolute offline root required",
        ));
    }
    release["releaseId"] = id.into();
    release["source"] = source.clone();
    Ok(release)
}
pub(super) fn reference(release: &Value) -> Value {
    json!({"identity":release["targetIdentity"],"packageIdentity":release["packageIdentity"],"releaseId":release["releaseId"],"sourceId":release["sourceId"]})
}
pub(super) fn validate_reference(ctx: &Context, value: &Value) -> Result<()> {
    if !hash(value["identity"].as_str().unwrap_or(""))
        || !hash(value["packageIdentity"].as_str().unwrap_or(""))
    {
        return Err(Error::new("STATE_INVALID", "Invalid installed reference"));
    }
    let expected = reference(&release(ctx, value["releaseId"].as_str().unwrap_or(""))?);
    if !super::equal(&expected, value) {
        return Err(Error::new(
            "APPROVAL_REQUIRED",
            "Receipt differs from approved release",
        ));
    }
    Ok(())
}
pub(super) fn source_url(release: &Value, relative: &str) -> Result<url::Url> {
    let source = &release["source"];
    let base = url::Url::parse(source["baseUrl"].as_str().unwrap_or(""))
        .map_err(|_| Error::new("SOURCE_REQUIRED", "Valid source base URL required"))?;
    let fixture = base.scheme() == "http"
        && matches!(base.host_str(), Some("127.0.0.1" | "[::1]"))
        && source["loopbackFixture"] == true;
    if !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || !base.path().ends_with('/')
        || !(base.scheme() == "https" || fixture)
    {
        return Err(Error::new(
            "UNSAFE_SOURCE",
            "HTTPS directory URL without credentials/query/fragment required",
        ));
    }
    if base.path() != "/" {
        let raw = &base.path()[1..base.path().len() - 1];
        for (index, byte) in raw.as_bytes().iter().enumerate() {
            if *byte == b'%'
                && (index + 2 >= raw.len()
                    || !raw.as_bytes()[index + 1..index + 3]
                        .iter()
                        .all(u8::is_ascii_hexdigit))
            {
                return Err(Error::new("UNSAFE_SOURCE", "Invalid URL encoding"));
            }
        }
        let decoded = percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map_err(|_| Error::new("UNSAFE_SOURCE", "Invalid URL encoding"))?;
        fs::relative(&decoded)?;
    }
    let path = release["path"].as_str().unwrap_or("");
    fs::relative(path)?;
    fs::relative(relative)?;
    const URI: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    let joined = format!("{path}/{relative}")
        .split('/')
        .map(|part| percent_encoding::utf8_percent_encode(part, URI).to_string())
        .collect::<Vec<_>>()
        .join("/");
    let url = base
        .join(&joined)
        .map_err(|_| Error::new("UNSAFE_SOURCE", "Invalid resource URL"))?;
    if url.origin() != base.origin() || !url.path().starts_with(base.path()) {
        return Err(Error::new("UNSAFE_SOURCE", "URL left approved source"));
    }
    Ok(url)
}
pub(super) struct Pack {
    pub root: PathBuf,
    pub manifest: Manifest,
    pub delta: Option<Value>,
    pub raw: Vec<u8>,
    pub delta_raw: Option<Vec<u8>>,
}
pub(super) fn package_identity(raw: &[u8], delta: Option<&[u8]>) -> String {
    digest(crate::storage::stringify(&json!([digest(raw), delta.map(digest)])).as_bytes())
}
pub(super) fn decode(raw: Vec<u8>, delta_raw: Option<Vec<u8>>, release: &Value) -> Result<Pack> {
    if package_identity(&raw, delta_raw.as_deref()) != release["packageIdentity"] {
        return Err(Error::new(
            "PACKAGE_UNAPPROVED",
            "Metadata differs from approved fingerprint",
        ));
    }
    if (release["kind"] == "delta") != delta_raw.is_some() {
        return Err(Error::new(
            "PACKAGE_KIND",
            "Full/delta kind differs from approval",
        ));
    }
    let parse = |bytes: &[u8]| {
        serde_json::from_slice(bytes)
            .map_err(|_| Error::new("METADATA_INVALID", "Package metadata not JSON"))
    };
    let manifest = Manifest::parse(&parse(&raw)?)?;
    let delta = delta_raw.as_ref().map(|bytes| parse(bytes)).transpose()?;
    if delta
        .as_ref()
        .map(|value| value["newManifest"]["contentIdentity"].clone())
        .unwrap_or_else(|| manifest.identity().into())
        != release["targetIdentity"]
    {
        return Err(Error::new(
            "TARGET_MISMATCH",
            "Target differs from independent approval",
        ));
    }
    Ok(Pack {
        root: PathBuf::new(),
        manifest,
        delta,
        raw,
        delta_raw,
    })
}
pub(super) fn pack_root(ctx: &Context, release: &Value) -> Result<PathBuf> {
    if release["source"]["kind"] == "offline" {
        fs::child(
            &file_paths::absolute(&PathBuf::from(release["source"]["root"].as_str().unwrap()))?,
            release["path"].as_str().unwrap(),
        )
    } else {
        fs::child(
            &ctx.store,
            &format!(
                "downloads/{}/pack",
                release["packageIdentity"].as_str().unwrap()
            ),
        )
    }
}
pub(super) fn read_pack(
    ctx: &Context,
    release: &Value,
    cancel: &CancellationToken,
) -> Result<Pack> {
    let root = pack_root(ctx, release)?;
    fs::safe(&root, false, false)?;
    let raw = fs::bytes(&root.join("manifest.json"), fs::MAX_JSON, false)?;
    let delta_path = root.join("delta.json");
    let delta = if fs::safe(&delta_path, true, false)?.is_some() {
        Some(fs::bytes(&delta_path, fs::MAX_JSON, false)?)
    } else {
        None
    };
    let mut pack = decode(raw, delta, release)?;
    manifest::verify(
        &root,
        &pack.manifest,
        if pack.delta.is_some() {
            &["manifest.json", "delta.json"]
        } else {
            &["manifest.json"]
        },
        cancel,
    )?;
    pack.root = root;
    Ok(pack)
}
pub(super) fn target(pack: &Pack, base: Option<&Manifest>, release: &Value) -> Result<Manifest> {
    let target = if let Some(delta) = &pack.delta {
        super::delta::reconstruct(
            base.ok_or_else(|| {
                Error::new(
                    "BASELINE_REQUIRED",
                    "Delta requires verified installed baseline",
                )
            })?,
            &pack.manifest,
            delta,
        )?
    } else {
        pack.manifest.clone()
    };
    if target.identity() != release["targetIdentity"] {
        return Err(Error::new(
            "TARGET_MISMATCH",
            "Reconstructed target differs from approval",
        ));
    }
    Ok(target)
}
