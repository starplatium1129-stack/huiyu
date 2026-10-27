use super::super::setup_verify::ModelFile;
use super::*;
use futures_util::{StreamExt, stream::FuturesUnordered};

const DOWNLOAD_CONCURRENCY: usize = 4;

impl ControlService {
    pub(super) async fn download_native_files(
        &self,
        root: &Path,
        files: &[Artifact],
        operation: &Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.download_native_files_authorized(root, files, operation, cancel, None, true)
            .await
    }

    pub(super) async fn download_native_files_authorized(
        &self,
        root: &Path,
        files: &[Artifact],
        operation: &Value,
        cancel: &CancellationToken,
        token: Option<&str>,
        allow_mirror: bool,
    ) -> Result<()> {
        stopped(cancel)?;
        plan::safe_directory(root)?;
        if files.is_empty() {
            return Ok(());
        }
        if token.is_some()
            && files
                .iter()
                .any(|file| !file.url.starts_with("https://huggingface.co/"))
        {
            return Err(ApiError::invalid("凭据只能用于固定 Hugging Face 模型来源"));
        }
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .default_headers(image_models::token_header(token)?)
            .build()
            .map_err(|_| {
                ApiError::new(502, "DOWNLOAD_FAILED", "无法连接下载源，请检查网络后重试")
            })?;
        let batch_cancel = cancel.child_token();
        let (events, mut progress) = tokio::sync::mpsc::channel(64);
        let mut remaining = files.iter().cloned().enumerate();
        let mut work = FuturesUnordered::new();
        let start = |(index, file)| {
            download_file(
                self.config.ai_workspace_root.clone(),
                root.to_owned(),
                index,
                file,
                client.clone(),
                events.clone(),
                batch_cancel.clone(),
                allow_mirror && token.is_none(),
            )
        };
        for entry in remaining.by_ref().take(DOWNLOAD_CONCURRENCY) {
            work.push(start(entry));
        }
        let mut rows = vec![(0u64, false); files.len()];
        loop {
            tokio::select! {
                result = work.next() => match result {
                    None => return Ok(()),
                    Some(Ok(index)) => {
                        rows[index] = (files[index].bytes, true);
                        self.native_progress(operation, json!({"downloadedBytes": rows.iter().map(|row| row.0).sum::<u64>()}));
                        if let Some(entry) = remaining.next() { work.push(start(entry)); }
                    }
                    Some(Err(error)) => {
                        // Drain every active writer before returning: cooperative cancellation
                        // flushes and retains resumable bytes and releases file ownership.
                        batch_cancel.cancel();
                        while work.next().await.is_some() {}
                        return Err(error);
                    }
                },
                Some((index, value)) = progress.recv() => {
                    if rows[index].1 { continue; }
                    rows[index].0 = value["bytesRead"].as_u64().unwrap_or(0).min(files[index].bytes);
                    self.native_progress(operation, json!({
                        "phase":value["phase"],"currentFile":files[index].path,
                        "downloadedBytes":rows.iter().map(|row| row.0).sum::<u64>(),
                        "message":value["message"].as_str().map(str::to_owned).unwrap_or_else(|| format!("{}：{}",
                            if value["phase"] == "downloading" {"下载中"} else {"校验中"}, files[index].path))
                    }));
                }
            }
        }
    }
}

async fn download_file(
    workspace: PathBuf,
    root: PathBuf,
    index: usize,
    file: Artifact,
    client: reqwest::Client,
    events: tokio::sync::mpsc::Sender<(usize, Value)>,
    cancel: CancellationToken,
    allow_mirror: bool,
) -> Result<usize> {
    stopped(&cancel)?;
    let (send, mut receive) = tokio::sync::mpsc::channel(16);
    let download = setup_download::managed_file(
        workspace,
        root,
        ModelFile {
            path: file.path,
            bytes: file.bytes,
            sha256: file.sha256,
        },
        file.url,
        &client,
        &send,
        &cancel,
        allow_mirror,
    );
    tokio::pin!(download);
    loop {
        tokio::select! {
            result = &mut download => return result.map(|_| index),
            Some(value) = receive.recv() => { let _ = events.try_send((index, value)); }
        }
    }
}
