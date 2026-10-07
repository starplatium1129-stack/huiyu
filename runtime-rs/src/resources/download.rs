mod http;
use super::{
    Error, Result, Value, config::cancelled, fs, json, lease, lifecycle::Operation, manifest,
    policy,
};
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
fn strong(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| {
            value.starts_with('"')
                && value.ends_with('"')
                && value.len() >= 2
                && !value.contains(['\r', '\n'])
        })
        .map(str::to_owned)
}
async fn matches(op: &Operation, path: PathBuf, entry: manifest::Entry) -> Result<bool> {
    let cancel = op.cancel.clone();
    super::blocking(move || fs::file_matches(&path, &entry, &cancel)).await
}
fn publish(op: &Operation, partial: &Path, target: &Path, entry: &manifest::Entry) -> Result<()> {
    cancelled(&op.cancel)?;
    fs::ensure(target.parent().unwrap())?;
    fs::safe(partial, false, false)?;
    fs::safe(target, true, false)?;
    fs::remove(target)?;
    std::fs::rename(partial, target)?;
    fs::sync(target.parent().unwrap())?;
    op.event("downloaded", json!({"path":entry.path}))
}
async fn entry(
    op: &Operation,
    client: &reqwest::Client,
    release: &Value,
    pack: &Path,
    parts: &Path,
    entry: &manifest::Entry,
) -> Result<()> {
    let target = fs::child(pack, &entry.path)?;
    if matches(op, target.clone(), entry.clone()).await? {
        return op.event("download-reused", json!({"path":entry.path}));
    }
    let key = super::digest(&entry.path);
    let partial = parts.join(format!("{key}.part"));
    let checkpoint = parts.join(format!("{key}.json"));
    let saved = fs::json(&checkpoint, true, false)?.unwrap_or(Value::Null);
    let mut stat = fs::safe(&partial, true, false)?;
    if stat
        .as_ref()
        .is_some_and(|stat| !stat.is_file() || stat.len() > entry.bytes)
    {
        return Err(Error::new("PARTIAL_INVALID", "Invalid partial resource"));
    }
    if stat.is_some() && (saved["sha256"] != entry.sha256 || saved["bytes"] != entry.bytes) {
        fs::remove(&partial)?;
        stat = None;
    }
    let mut offset = stat.as_ref().map(|stat| stat.len()).unwrap_or(0);
    if stat.is_some() && offset == entry.bytes {
        if matches(op, partial.clone(), entry.clone()).await? {
            return publish(op, &partial, &target, entry);
        }
        fs::remove(&partial)?;
        offset = 0;
    }
    fs::space(&op.ctx.store, entry.bytes - offset + 65536)?;
    let previous = strong(saved["etag"].as_str());
    let mut headers = reqwest::header::HeaderMap::new();
    if offset > 0 {
        headers.insert("range", format!("bytes={offset}-").parse().unwrap());
        if let Some(etag) = &previous {
            headers.insert(
                "if-range",
                etag.parse()
                    .map_err(|_| Error::new("PARTIAL_INVALID", "Invalid checkpoint ETag"))?,
            );
        }
    }
    let mut response = http::response(
        client,
        policy::source_url(release, &entry.path)?,
        headers,
        &op.cancel,
    )
    .await?;
    let mut start = http::range(
        &response,
        offset,
        entry.bytes,
        if offset > 0 {
            previous.as_deref()
        } else {
            None
        },
    );
    if offset > 0
        && (response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE
            || start
                .as_ref()
                .is_err_and(|error| error.code == "HTTP_RANGE"))
    {
        // A stale validator or rejected range must not trap every recovery on
        // the same checkpoint. Retry once without Range, retaining the partial
        // until a valid full response is available. Never retry network errors.
        drop(response);
        op.check()?;
        response = http::response(
            client,
            policy::source_url(release, &entry.path)?,
            reqwest::header::HeaderMap::new(),
            &op.cancel,
        )
        .await?;
        start = http::range(&response, 0, entry.bytes, None);
    }
    let start = start?;
    fs::space(&op.ctx.store, entry.bytes - start + 65536)?;
    let etag = strong(
        response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok()),
    );
    fs::write_json(
        &checkpoint,
        &json!({"schemaVersion":1,"sha256":entry.sha256,"bytes":entry.bytes,"etag":etag}),
    )?;
    fs::safe(&partial, true, false)?;
    let mut options = std::fs::OpenOptions::new();
    options
        .write(true)
        .create(true)
        .append(start > 0)
        .truncate(start == 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let opened = options.open(&partial)?;
    fs::safe(&partial, false, false)?;
    if crate::file_identity::opened(&opened)? != crate::file_identity::path(&partial, false)? {
        return Err(Error::new("FILE_CHANGED", "Partial changed while opening"));
    }
    let mut output = tokio::fs::File::from_std(opened);
    let mut received = start;
    let mut stream = response.bytes_stream();
    let copied=async{loop{let next=tokio::select!{_ = op.cancel.cancelled()=>return Err(Error::new("CANCELLED","Download cancelled")),value=tokio::time::timeout(std::time::Duration::from_secs(30),stream.next())=>value.map_err(|_|Error::new("HTTP_TIMEOUT","Resource source timed out"))?};let Some(chunk)=next else{break;};let chunk=chunk.map_err(|_|Error::new("HTTP_FAILED","Resource response interrupted"))?;op.check()?;if received+chunk.len()as u64>entry.bytes{return Err(Error::new("HTTP_SIZE","Response exceeds approved length"));}fs::safe(&partial,false,false)?;output.write_all(&chunk).await?;received+=chunk.len()as u64;op.event("download-progress",json!({"path":entry.path,"bytes":received,"total":entry.bytes,"resumedFrom":start}))?;}if received!=entry.bytes{return Err(Error::new("HTTP_SIZE","Resource response incomplete"));}Ok(())}.await;
    // Tokio file writes can finish in the background. Surface the final write
    // error before hashing, while retaining a resumable partial on disk errors.
    let synced = async {
        output.flush().await?;
        output.sync_all().await
    }
    .await;
    drop(output);
    copied?;
    synced?;
    if !matches(op, partial.clone(), entry.clone()).await? {
        fs::remove(&partial)?;
        return Err(Error::new(
            "CONTENT_INVALID",
            "Downloaded bytes differ from approved hash",
        ));
    }
    publish(op, &partial, &target, entry)
}
pub(super) async fn run(op: Operation, client: reqwest::Client, id: String) -> Result<Value> {
    let release = policy::release(&op.ctx, &id)?;
    if release["source"]["kind"] != "http" {
        return Err(Error::new(
            "SOURCE_REQUIRED",
            "Download requires configured HTTP source",
        ));
    }
    let manifest_url = policy::source_url(&release, "manifest.json")?;
    cancelled(&op.cancel)?;
    op.ctx.initialize()?;
    let _lock = lease::acquire(&op.ctx, "writer", 0)?;
    let directory = fs::child(
        &op.ctx.store,
        &format!("downloads/{}", release["packageIdentity"].as_str().unwrap()),
    )?;
    let pack = directory.join("pack");
    let parts = directory.join("parts");
    let complete = directory.join("complete.json");
    let done = fs::json(&complete, true, false)?;
    if done
        .as_ref()
        .is_some_and(|done| done["packageIdentity"] == release["packageIdentity"])
    {
        let ctx = op.ctx.clone();
        let approved = release.clone();
        let cancel = op.cancel.clone();
        match super::blocking(move || policy::read_pack(&ctx, &approved, &cancel)).await {
            Ok(existing) => {
                return Ok(
                    json!({"ok":true,"kind":"resource-download-result","action":"already-downloaded","releaseId":id,"installed":false,"files":existing.manifest.entries.len()}),
                );
            }
            Err(error)
                if [
                    "CONTENT_INVALID",
                    "PACKAGE_UNAPPROVED",
                    "TARGET_MISMATCH",
                    "METADATA_INVALID",
                ]
                .contains(&error.code.as_str()) =>
            {
                fs::remove(&complete)?
            }
            Err(error) => return Err(error),
        }
    }
    let raw = http::metadata(&client, manifest_url, &op.cancel).await?;
    let delta = if release["kind"] == "delta" {
        Some(
            http::metadata(
                &client,
                policy::source_url(&release, "delta.json")?,
                &op.cancel,
            )
            .await?,
        )
    } else {
        None
    };
    let decoded = policy::decode(raw, delta, &release)?;
    op.check()?;
    fs::space(
        &op.ctx.store,
        decoded.raw.len() as u64
            + decoded
                .delta_raw
                .as_ref()
                .map(|bytes| bytes.len())
                .unwrap_or(0) as u64
            + 65536,
    )?;
    fs::ensure(&pack)?;
    fs::ensure(&parts)?;
    fs::clean_temps(&pack, &["manifest.json", "delta.json"])?;
    fs::atomic(&pack.join("manifest.json"), &decoded.raw)?;
    if let Some(delta) = &decoded.delta_raw {
        fs::atomic(&pack.join("delta.json"), delta)?;
    }
    for resource in &decoded.manifest.entries {
        entry(&op, &client, &release, &pack, &parts, resource).await?;
    }
    let root = pack.clone();
    let manifest = decoded.manifest.clone();
    let delta = decoded.delta.is_some();
    let cancel = op.cancel.clone();
    super::blocking(move || {
        manifest::verify(
            &root,
            &manifest,
            if delta {
                &["manifest.json", "delta.json"]
            } else {
                &["manifest.json"]
            },
            &cancel,
        )
    })
    .await?;
    op.check()?;
    fs::write_json(
        &complete,
        &json!({"schemaVersion":1,"packageIdentity":release["packageIdentity"]}),
    )?;
    Ok(
        json!({"ok":true,"kind":"resource-download-result","action":"downloaded","releaseId":id,"installed":false,"files":decoded.manifest.entries.len()}),
    )
}
