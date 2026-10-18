//! Standalone lines use the primary result; manga pages own an optional sidecar.
use super::*;
use std::path::Path;

pub(in crate::generation) async fn outputs(input: &Value, primary: Output) -> Result<Vec<Output>> {
    let mut outputs = vec![primary];
    if has_lines(input) && input["operation"] != "lineart" {
        let Output::File { path, .. } = &outputs[0] else {
            return Err(protocol_error());
        };
        let path = lineart_path(path, input);
        let stat = tokio::fs::symlink_metadata(&path).await?;
        if !stat.is_file()
            || stat.file_type().is_symlink()
            || stat.len() == 0
            || stat.len() > 32 * 1024 * 1024
        {
            return Err(protocol_error());
        }
        outputs.push(Output::File {
            path,
            mime: "image/png".into(),
            bytes: stat.len(),
        });
    }
    Ok(outputs)
}

pub(in crate::generation) async fn collect(
    job: &Job,
    hooks: &dyn ExecutionHooks,
    primary: Output,
) -> Result<()> {
    let outputs = outputs(&job.input, primary).await?;
    if job.input["family"] == "manga-screen" {
        // Persist observed dimensions/line provenance BEFORE media commits. A
        // restart after the last commit can complete delivery without inference.
        let metadata = job.state.lock().await.metadata.clone();
        hooks
            .checkpoint(json!({"gatewayJobId":job.id, "effectiveInput":job.input,
            "mangaResultMetadata":metadata}))
            .await?;
    }
    hooks.collect(outputs).await
}

pub(super) fn has_lines(input: &Value) -> bool {
    input["family"] == "manga-screen"
        && (input["autoLines"] == true || input["penLines"].is_string())
}
pub(crate) fn lineart_path(page: &Path, input: &Value) -> PathBuf {
    if input["operation"] == "lineart" {
        return page.to_path_buf();
    }
    page.with_file_name(format!(
        "{}-lineart.png",
        page.file_stem().unwrap_or_default().to_string_lossy()
    ))
}
pub(super) async fn validate(job: &Job, page: &Path, cancel: &CancellationToken) -> Result<()> {
    if !has_lines(&job.input) {
        return Ok(());
    }
    let path = lineart_path(page, &job.input);
    let stat = tokio::fs::symlink_metadata(&path).await?;
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 32 * 1024 * 1024 {
        return Err(protocol_error());
    }
    // The primary PNG has already passed decoder admission in the caller.
    if job.input["operation"] != "lineart" {
        output::validate(&path, false, cancel).await?;
    }
    let (width, height) = output::png_dimensions(&path).await?;
    if !(128..=4096).contains(&width)
        || !(128..=4096).contains(&height)
        || u64::from(width) * u64::from(height) > 2097152
    {
        return Err(protocol_error());
    }
    job.state.lock().await.metadata["lineartResult"] = json!({"width":width,"height":height,
        "polarity":"black-on-white","stage":if job.input["operation"]=="lineart"{"extracted"}else{"before-panel"},"validation":"待主力机验证"});
    Ok(())
}

// Covers errors between the two synchronous publications. The main result owns
// the sidecar only after both files are published; drop removes partial output.
pub(super) struct Publication {
    path: Option<PathBuf>,
}
impl Publication {
    pub(super) fn stage(job: &Job, source: &Path, destination: &Path) -> Result<Self> {
        let path = if has_lines(&job.input) && job.input["operation"] != "lineart" {
            let path = lineart_path(destination, &job.input);
            tempfile::TempPath::try_from_path(lineart_path(source, &job.input))?
                .persist_noclobber(&path)
                .map_err(|e| ApiError::from(e.error))?;
            Some(path)
        } else {
            None
        };
        Ok(Self { path })
    }
    pub(super) fn commit(mut self) {
        self.path.take();
    }
}
impl Drop for Publication {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}
pub(in crate::generation) async fn discard(job: &Job, page: &Path) {
    if has_lines(&job.input) && job.input["operation"] != "lineart" {
        let _ = tokio::fs::remove_file(lineart_path(page, &job.input)).await;
    }
}
