use super::setup_verify::{ModelFile, inspect, same_file_at};
use super::*;
use crate::file_identity::{self, Version};
#[cfg(windows)]
mod archives;
mod stream;
#[path = "setup_transfer.rs"]
mod transfer;

use std::path::PathBuf;
use tokio::{io::AsyncWriteExt, sync::mpsc::Sender};

#[cfg(windows)]
pub(super) use archives::VerifiedArchives;
pub(super) use stream::{BatchDownloadRequest, DownloadRequest};

struct DownloadPlan {
    workspace: PathBuf,
    root: PathBuf,
    spec: ModelFile,
    url: String,
    id: String,
    allow_mirror: bool,
    parallel_ranges: bool,
    #[cfg(windows)]
    archive_checks: Option<Arc<VerifiedArchives>>,
}

// Both installation flows use the same resumable transport, fixed digest check
// and atomic no-clobber publication. Native setup owns the receiver separately
// from the UI so closing a panel only detaches its observer.
pub(super) async fn managed_file(
    workspace: PathBuf,
    root: PathBuf,
    spec: ModelFile,
    url: String,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
    allow_mirror: bool,
    #[cfg(windows)] archive_checks: Arc<VerifiedArchives>,
) -> Result<Value> {
    let plan = DownloadPlan {
        workspace,
        root,
        spec,
        url,
        id: "native-setup".into(),
        allow_mirror,
        parallel_ranges: false,
        #[cfg(windows)]
        archive_checks: Some(archive_checks),
    };
    download(&plan, client, send, cancel).await
}

fn stopped(cancel: &CancellationToken, send: &Sender<Value>) -> Result<()> {
    if cancel.is_cancelled() || send.is_closed() {
        Err(ApiError::new(409, "CANCELLED", "下载已取消，已有模型保留"))
    } else {
        Ok(())
    }
}
fn io_error(error: std::io::Error) -> ApiError {
    if matches!(error.raw_os_error(), Some(28 | 112)) {
        ApiError::new(409, "ENOSPC", "目标盘剩余空间不足，已有模型保留")
    } else {
        ApiError::new(
            500,
            "MODEL_IO",
            "无法写入模型目录，请检查本机权限和磁盘后重试",
        )
    }
}
fn changed() -> ApiError {
    ApiError::new(
        409,
        "WORKSPACE_CHANGED",
        "下载期间工作区或模型目录改变，已停止；请重新检查",
    )
}
fn progress(plan: &DownloadPlan, send: &Sender<Value>, phase: &str, bytes: u64) {
    let _ = send.try_send(json!({"type":"progress","modelId":plan.id,"phase":phase,"bytesRead":bytes,"expectedBytes":plan.spec.bytes}));
}
fn result(
    plan: &DownloadPlan,
    state: &str,
    bytes: Option<u64>,
    hash: Option<&str>,
    code: Option<&str>,
    message: &str,
) -> Value {
    json!({"type":"result","modelId":plan.id,"path":plan.root.join(&plan.spec.path),"state":state,
        "bytes":bytes,"sha256":hash,"code":code,"checkedAt":now(),"message":message})
}

async fn inspect_file(
    plan: &DownloadPlan,
    root: PathBuf,
    spec: ModelFile,
    phase: &str,
    send: &Sender<Value>,
    cancel: &CancellationToken,
) -> Result<Value> {
    progress(plan, send, phase, 0);
    let (events, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let id = plan.id.clone();
    let token = cancel.clone();
    let mut worker =
        tokio::task::spawn_blocking(move || inspect(&root, &spec, &id, &events, &token));
    let inspected = loop {
        tokio::select! {
            value = &mut worker => break value.map_err(|_| changed())?,
            Some(event) = receive.recv() => { progress(plan, send, phase, event["bytesRead"].as_u64().unwrap_or(0)); }
        }
    };
    stopped(cancel, send)?;
    Ok(inspected)
}

async fn download(
    plan: &DownloadPlan,
    client: &reqwest::Client,
    send: &Sender<Value>,
    cancel: &CancellationToken,
) -> Result<Value> {
    stopped(cancel, send)?;
    let root = plan.root.clone();
    let path = root.join(&plan.spec.path);
    let workspace = plan.workspace.clone();
    let parent = path.parent().unwrap().to_path_buf();
    let root_check = root.clone();
    let (real_workspace, real_root, real_parent) =
        tokio::task::spawn_blocking(move || -> Result<_> {
            std::fs::create_dir_all(&workspace).map_err(io_error)?;
            let real_workspace = workspace.canonicalize().map_err(io_error)?;
            if !real_workspace.is_dir() {
                return Err(changed());
            }
            std::fs::create_dir_all(&parent).map_err(io_error)?;
            let real_root = root_check.canonicalize().map_err(io_error)?;
            let real_parent = parent.canonicalize().map_err(io_error)?;
            if !real_parent.starts_with(&real_root) {
                return Err(changed());
            }
            Ok((real_workspace, real_root, real_parent))
        })
        .await
        .map_err(|_| changed())??;
    if tokio::fs::symlink_metadata(&path).await.is_ok() {
        #[cfg(windows)]
        let held = if let Some(checks) = plan.archive_checks.clone() {
            let (path, root, hash) = (path.clone(), root.clone(), plan.spec.sha256.clone());
            tokio::task::spawn_blocking(move || checks.hold(&path, &root, &hash).ok())
                .await
                .map_err(|_| changed())?
        } else {
            None
        };
        #[cfg(windows)]
        let already_checked = held.as_ref().is_some_and(|(file, checked)| {
            *checked
                && file
                    .metadata()
                    .is_ok_and(|metadata| metadata.len() == plan.spec.bytes)
        });
        #[cfg(not(windows))]
        let already_checked = false;
        stopped(cancel, send)?;
        let verified = if already_checked {
            true
        } else {
            let inspected = inspect_file(
                plan,
                root.clone(),
                plan.spec.clone(),
                "checking",
                send,
                cancel,
            )
            .await?;
            inspected["state"] == "sha256-match"
        };
        if verified {
            #[cfg(windows)]
            if let (Some(checks), Some((file, false))) = (&plan.archive_checks, held)
                && let Ok(identity) = file_identity::opened(&file)
            {
                checks.record(path.clone(), plan.spec.sha256.clone(), identity, &file);
            }
            return Ok(result(
                plan,
                "already-present",
                Some(plan.spec.bytes),
                Some(&plan.spec.sha256),
                None,
                "已有文件与固定大小及 SHA-256 一致；未下载、未运行模型",
            ));
        }
        return Err(ApiError::new(
            409,
            "MODEL_CONFLICT",
            "同名模型已存在，内容未匹配固定清单；请先核对并自行移走冲突文件，下载不会替换它",
        ));
    }
    let partial_path = real_parent.join(format!(".huiyu-{}.part", plan.spec.sha256));
    let retained = tokio::fs::metadata(&partial_path)
        .await
        .ok()
        .filter(|m| m.is_file() && m.len() <= plan.spec.bytes)
        .map(|m| m.len())
        .unwrap_or(0);
    let space_path = real_parent.clone();
    let needed = plan
        .spec
        .bytes
        .saturating_sub(retained)
        .saturating_add(65536);
    tokio::task::spawn_blocking(move || {
        crate::resources::check_available_space(&space_path, needed)
    })
    .await
    .map_err(|_| changed())?
    .map_err(|error| {
        ApiError::new(
            409,
            &error.code,
            if error.code == "ENOSPC" {
                "目标盘剩余空间不足，已有模型保留"
            } else {
                "无法检查目标盘剩余空间，请核对磁盘与本机权限"
            },
        )
    })?;
    stopped(cancel, send)?;
    #[cfg(windows)]
    let protect_archive = plan.archive_checks.is_some();
    let (temporary, identity) = tokio::task::spawn_blocking(move || -> std::io::Result<_> {
        let partial = partial_path;
        if let Ok(meta) = std::fs::symlink_metadata(&partial)
            && !meta.is_file()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Partial download is not a regular file",
            ));
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(windows)]
        if protect_archive {
            use std::os::windows::fs::OpenOptionsExt;
            // The verified handle survives the rename. Other processes may
            // read it, but cannot modify the bytes before we record its identity.
            options.share_mode(0x1 | 0x4); // FILE_SHARE_READ | FILE_SHARE_DELETE
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        let file = options.open(&partial)?;
        // Validate the opened object before writes or TempPath cleanup own it.
        // A resumable name can be a hard link to an unrelated existing file.
        let identity = file_identity::opened(&file)?;
        if !file.metadata()?.is_file() || identity.links != 1 || !same_file_at(&partial, &identity)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Partial download must be an exclusively linked regular file",
            ));
        }
        let mut temporary =
            tempfile::NamedTempFile::from_parts(file, tempfile::TempPath::try_from_path(partial)?);
        // A request deadline can drop the worker while a platform file write is
        // finishing. A resumable path survives even when cleanup cannot run.
        temporary.disable_cleanup(true);
        Ok((temporary, identity))
    })
    .await
    .map_err(|_| changed())?
    .map_err(io_error)?;
    let (count, version) = {
        // Network frames can be only a few KiB. Batch them before Tokio's
        // blocking file worker; all exit paths below flush retained bytes.
        let mut output = tokio::io::BufWriter::with_capacity(
            1024 * 1024,
            tokio::fs::File::from_std(temporary.as_file().try_clone().map_err(io_error)?),
        );
        let transferred = transfer::write(plan, client, send, cancel, &mut output).await;
        // Tokio may have accepted bytes while its blocking write is still queued.
        // Drain that write before cancellation/error cleanup inspects and retains the file.
        let flushed = output.flush().await;
        flushed.map_err(io_error)?;
        let count = transferred?;
        if count != plan.spec.bytes {
            return Err(ApiError::new(
                502,
                "DOWNLOAD_FAILED",
                "下载不完整，未发布模型文件；请重试",
            ));
        }
        output.get_ref().sync_all().await.map_err(io_error)?;
        drop(output);
        (count, Version::of(temporary.as_file()).map_err(io_error)?)
    };
    let temp_spec = ModelFile {
        path: temporary
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        ..plan.spec.clone()
    };
    let verified = inspect_file(
        plan,
        real_parent.clone(),
        temp_spec,
        "verifying",
        send,
        cancel,
    )
    .await?;
    stopped(cancel, send)?;
    let current_workspace = plan.workspace.clone();
    let current_parent = path.parent().unwrap().to_path_buf();
    let token = cancel.clone();
    #[cfg(windows)]
    let archive_checks = plan.archive_checks.clone();
    #[cfg(windows)]
    let archive_hash = plan.spec.sha256.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        if current_workspace.canonicalize().ok().as_ref() != Some(&real_workspace)
            || root.canonicalize().ok().as_ref() != Some(&real_root)
            || current_parent.canonicalize().ok().as_ref() != Some(&real_parent)
            || !same_file_at(temporary.path(), &identity)
            || Version::of(temporary.as_file()).ok().as_ref() != Some(&version)
        {
            return Err(changed());
        }
        if token.is_cancelled() {
            return Err(ApiError::new(409, "CANCELLED", "下载已取消"));
        }
        match verified["state"].as_str() {
            Some("sha256-match") => {}
            Some("hash-mismatch" | "size-mismatch") => {
                temporary.close().map_err(io_error)?;
                return Err(ApiError::new(
                    502,
                    "HASH_MISMATCH",
                    "下载文件校验失败，已清理临时文件；请重试下载",
                ));
            }
            Some("changed") => return Err(changed()),
            _ => {
                return Err(ApiError::new(
                    500,
                    "MODEL_IO",
                    verified["message"]
                        .as_str()
                        .unwrap_or("无法校验下载文件，请重试"),
                ));
            }
        }
        // Same-directory, atomic no-clobber publication preserves an existing file.
        let _published = temporary.persist_noclobber(&path).map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                ApiError::new(
                    409,
                    "MODEL_CONFLICT",
                    "下载期间出现同名文件，原文件保留；请核对冲突后重试",
                )
            } else {
                io_error(error.error)
            }
        })?;
        #[cfg(windows)]
        if let Some(checks) = archive_checks {
            checks.record(path, archive_hash, identity, &_published);
        }
        Ok(())
    })
    .await
    .map_err(|_| changed())??;
    Ok(result(
        plan,
        "downloaded",
        Some(count),
        Some(&plan.spec.sha256),
        None,
        "下载文件大小与 SHA-256 校验通过，已发布；请重新检查，尚未验证加载或出图",
    ))
}
