//! 桌面端自动更新（2026-08-29 产品运营审计 P1：Tauri updater 落地）。
//!
//! 公钥与 GitHub Releases 端点在 tauri.conf.json `plugins.updater`；产物由
//! scripts/maintenance/release-desktop-update.js 签名发布。启动时后台检查一次：
//! 发现新版本 → 系统通知 + 全局事件
//! `desktop-update-found`；控制面板横幅点击后经 `desktop_update_install`
//! 下载安装并由安装器重启（passive 模式，不弹交互向导）。

use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::watch;

mod cache;
mod download;
#[cfg(test)]
mod download_tests;
mod verify;

// One process may have several windows, each with its own update banner.
static SESSION: UpdateSession = UpdateSession(Mutex::new(SessionState {
    active: false,
    cancel: None,
    revision: 0,
    phase: UpdatePhase::Idle,
    version: String::new(),
    status_text: String::new(),
    error_text: String::new(),
}));

#[derive(Clone, Copy, Default, serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    Downloading,
    Verifying,
    Cancelling,
    Installing,
    Cancelled,
    Failed,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    revision: u64,
    phase: UpdatePhase,
    version: String,
    status_text: String,
    error_text: String,
    can_cancel: bool,
}

#[derive(Default)]
struct SessionState {
    active: bool,
    cancel: Option<watch::Sender<bool>>,
    revision: u64,
    phase: UpdatePhase,
    version: String,
    status_text: String,
    error_text: String,
}

impl SessionState {
    fn snapshot(&self) -> UpdateSnapshot {
        UpdateSnapshot {
            revision: self.revision,
            phase: self.phase,
            version: self.version.clone(),
            status_text: self.status_text.clone(),
            error_text: self.error_text.clone(),
            can_cancel: self.cancel.as_ref().is_some_and(|sender| !*sender.borrow()),
        }
    }
}

#[derive(Default)]
struct UpdateSession(Mutex<SessionState>);
struct SessionGuard<'a> {
    session: &'a UpdateSession,
    finished: bool,
}

impl UpdateSession {
    fn snapshot(&self) -> UpdateSnapshot {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .snapshot()
    }

    fn begin(&self) -> Result<(SessionGuard<'_>, watch::Receiver<bool>), String> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.active {
            return Err("已有更新正在进行，请等待完成或取消下载".into());
        }
        let (cancel, receiver) = watch::channel(false);
        state.active = true;
        state.cancel = Some(cancel);
        state.revision += 1;
        state.phase = UpdatePhase::Checking;
        state.status_text = "正在检查更新…".into();
        state.error_text.clear();
        Ok((
            SessionGuard {
                session: self,
                finished: false,
            },
            receiver,
        ))
    }

    fn cancel(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let accepted = state.cancel.as_ref().is_some_and(|sender| {
            let cancelled = *sender.borrow();
            !cancelled && sender.send(true).is_ok()
        });
        if accepted {
            state.revision += 1;
            state.phase = UpdatePhase::Cancelling;
            state.status_text = "正在取消更新…".into();
        }
        accepted
    }
}

impl SessionGuard<'_> {
    fn report(&self, app: &AppHandle, phase: UpdatePhase, version: Option<&str>, text: String) {
        let snapshot = {
            let mut state = self
                .session
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            // A final download callback must never undo an accepted cancellation.
            if state.phase == UpdatePhase::Cancelling {
                return;
            }
            state.revision += 1;
            state.phase = phase;
            if let Some(version) = version {
                state.version = version.into();
            }
            state.status_text = text;
            state.snapshot()
        };
        let _ = app.emit("desktop-update-state", snapshot);
    }

    fn commit_install(&self) -> bool {
        let mut state = self
            .session
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Serialize cancellation with the hand-off to the installer. Never install
        // bytes after accepting a cancellation, even if the last chunk won select.
        let accepted = state.cancel.take().is_some_and(|sender| !*sender.borrow());
        if accepted {
            state.revision += 1;
            state.phase = UpdatePhase::Installing;
            state.status_text = "签名校验通过，正在启动安装器…".into();
        }
        accepted
    }

    fn finish(mut self, result: &Result<bool, String>) -> UpdateSnapshot {
        let mut state = self
            .session
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Release the gate before announcing that another explicit attempt is allowed.
        state.active = false;
        state.cancel = None;
        state.revision += 1;
        match result {
            Err(error) => {
                state.phase = UpdatePhase::Failed;
                state.status_text.clear();
                state.error_text = error.clone();
            }
            Ok(false) => {
                state.phase = UpdatePhase::Cancelled;
                state.status_text = "更新已取消；再次升级将尝试续传，缓存失效时重新下载".into();
            }
            Ok(true) => {
                state.phase = UpdatePhase::Idle;
                state.status_text.clear();
            }
        }
        self.finished = true;
        state.snapshot()
    }
}

impl Drop for SessionGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let mut state = self
            .session
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.active = false;
        state.cancel = None;
        state.revision += 1;
        state.phase = UpdatePhase::Idle;
        state.status_text.clear();
    }
}

#[derive(Default)]
struct DownloadProgress {
    last_report: Option<Duration>,
}

impl DownloadProgress {
    fn report(
        &mut self,
        downloaded: u64,
        total: Option<u64>,
        transferred: u64,
        elapsed: Duration,
    ) -> Option<String> {
        if self
            .last_report
            .is_some_and(|last| elapsed.saturating_sub(last) < Duration::from_millis(500))
        {
            return None;
        }
        self.last_report = Some(elapsed);
        let downloaded_mib = downloaded as f64 / 1_048_576.0;
        // Cached bytes affect completion, never the measured network throughput.
        let rate = transferred as f64 / 1_048_576.0 / elapsed.as_secs_f64().max(0.001);
        Some(match total.filter(|total| *total > 0) {
            Some(total) => format!(
                "已下载 {downloaded_mib:.1} / {:.1} MiB（{:.0}%），本次平均 {rate:.2} MiB/s",
                total as f64 / 1_048_576.0,
                (downloaded as f64 / total as f64 * 100.0).min(100.0)
            ),
            None => {
                format!("已下载 {downloaded_mib:.1} MiB，本次平均 {rate:.2} MiB/s（总大小未知）")
            }
        })
    }
}

/// 启动后台检查一次（静默失败：更新不可达不影响正常使用）。
pub fn spawn_startup_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = notify_if_update_available(&app).await {
            eprintln!("[aics-updater] startup check failed: {error}");
        }
    });
}

async fn notify_if_update_available(app: &AppHandle) -> Result<(), String> {
    let Some(update) = check(app).await? else {
        return Ok(());
    };
    let version = update.version.clone();
    let _ = app.emit("desktop-update-found", version.clone());
    app.notification()
        .builder()
        .title("绘遇 · HUIYU 有新版本")
        .body(format!("发现 {version}，到控制面板可一键升级。"))
        .show()
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn check(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let updater = app
        .updater_builder()
        // Bound connect/stalled reads, not the entire 600 MiB download. A short
        // updater.timeout() would also apply to the package and break slow links.
        .configure_client(download::configure_client)
        .build()
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(30), updater.check())
        .await
        .map_err(|_| "检查更新超时，请检查网络后重试".to_string())?
        .map_err(|error| format!("检查更新失败，请检查网络后重试：{error}"))
}

/// 供前端查询当前可用更新（无更新返回 null）。
#[tauri::command]
pub async fn desktop_update_check(app: AppHandle) -> Result<Option<String>, String> {
    let update = check(&app).await?;
    Ok(update.map(|update| update.version))
}

/// Current process session; querying it never starts a network check or download.
#[tauri::command]
pub fn desktop_update_state() -> UpdateSnapshot {
    SESSION.snapshot()
}

/// 下载并安装更新，安装器结束后自动重启应用（passive 模式）。
#[tauri::command]
pub async fn desktop_update_install(app: AppHandle) -> Result<bool, String> {
    let (session, mut cancelled) = SESSION.begin()?;
    let _ = app.emit("desktop-update-state", SESSION.snapshot());
    let result = async {
        let download = async {
            let Some(update) = check(&app).await? else {
                return Err("当前已是最新版本".to_string());
            };
            session.report(
                &app,
                UpdatePhase::Downloading,
                Some(&update.version),
                format!("正在连接下载 {}，等待服务器响应…", update.version),
            );
            let started = Instant::now();
            let mut progress = DownloadProgress::default();
            let config: tauri_plugin_updater::Config = serde_json::from_value(
                app.config()
                    .plugins
                    .0
                    .get("updater")
                    .cloned()
                    .ok_or("缺少更新配置")?,
            )
            .map_err(|error| error.to_string())?;
            let identity_bytes = serde_json::to_vec(&(
                1,
                &app.config().identifier,
                &update.current_version,
                &update.version,
                &update.target,
                std::env::consts::ARCH,
                update.download_url.as_str(),
                &update.signature,
                &config.pubkey,
            ))
            .map_err(|error| error.to_string())?;
            let identity = ring::digest::digest(&ring::digest::SHA256, &identity_bytes)
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let root = app
                .path()
                .app_local_data_dir()
                .map_err(|e| e.to_string())?
                .join("updater-cache-v1");
            let mut cache = cache::Cache::open(&root, &identity)?;
            if cache.len()? > 0 {
                session.report(
                    &app,
                    UpdatePhase::Downloading,
                    None,
                    "正在检查已下载缓存并尝试续传…".into(),
                );
            }
            download::fetch(
                &download::client(&update)?,
                &update.download_url,
                &update.headers,
                &mut cache,
                |downloaded, total, transferred| {
                    if let Some(text) =
                        progress.report(downloaded, total, transferred, started.elapsed())
                    {
                        session.report(&app, UpdatePhase::Downloading, None, text);
                    }
                },
            )
            .await?;
            session.report(
                &app,
                UpdatePhase::Verifying,
                None,
                "下载完成，正在校验完整安装包签名…".into(),
            );
            let signature = update.signature.clone();
            let version = update.version.clone();
            // Reading and verifying 600+ MiB must not block cancellation/event delivery.
            // If cancelled, the worker can finish verification but can never install.
            let (cache, bytes) = tauri::async_runtime::spawn_blocking(move || {
                let bytes = cache.bytes()?;
                if let Err(error) = verify::verify(
                    &bytes,
                    &signature,
                    &config.pubkey,
                    &version,
                    config.require_signed_version,
                ) {
                    cache.reset(&identity)?;
                    return Err(format!(
                        "更新签名校验失败，缓存已清除，请重新检查更新：{error}"
                    ));
                }
                Ok::<_, String>((cache, bytes))
            })
            .await
            .map_err(|error| error.to_string())??;
            Ok((update, bytes, cache))
        };
        let (update, bytes, mut cache) = tokio::select! {
            biased;
            _ = cancelled.wait_for(|cancelled| *cancelled) => return Ok(false),
            result = download => result?,
        };
        if !session.commit_install() {
            return Ok(false);
        }
        let _ = app.emit("desktop-update-state", SESSION.snapshot());
        // Tauri exits this process on successful Windows hand-off, so retire only our
        // slot now. An installer launch failure may require downloading again.
        cache.reset("")?;
        update
            .install(bytes)
            .map_err(|error| format!("启动更新安装器失败：{error}"))?;
        app.restart()
    }
    .await;
    let _ = app.emit("desktop-update-state", session.finish(&result));
    result
}

/// Only cancels checking/downloading. The installer owns the update after hand-off.
#[tauri::command]
pub fn desktop_update_cancel(app: AppHandle) -> bool {
    let accepted = SESSION.cancel();
    let _ = app.emit("desktop-update-state", SESSION.snapshot());
    accepted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_download_at_a_time_and_cancel_wins_before_install() {
        let session = UpdateSession::default();
        assert_eq!(session.snapshot().phase, UpdatePhase::Idle);
        let (guard, receiver) = session.begin().unwrap();
        let checking = session.snapshot();
        assert_eq!(checking.phase, UpdatePhase::Checking);
        assert!(checking.can_cancel);
        assert!(session.begin().is_err());
        assert!(session.cancel());
        assert!(*receiver.borrow());
        let cancelling = session.snapshot();
        assert!(cancelling.revision > checking.revision);
        assert_eq!(cancelling.phase, UpdatePhase::Cancelling);
        assert!(!cancelling.can_cancel);
        assert!(
            !session.cancel(),
            "an accepted cancellation cannot be accepted twice"
        );
        assert!(
            session.begin().is_err(),
            "cancellation must finish before retry"
        );
        assert!(!guard.commit_install());
        let cancelled = guard.finish(&Ok(false));
        assert_eq!(cancelled.phase, UpdatePhase::Cancelled);
        assert!(!cancelled.can_cancel);
        assert!(cancelled.revision > cancelling.revision);
        let (guard, _) = session.begin().unwrap();
        assert!(guard.commit_install());
        assert_eq!(session.snapshot().phase, UpdatePhase::Installing);
        assert!(!session.snapshot().can_cancel);
        assert!(
            !session.cancel(),
            "installer cannot be cancelled as a download"
        );
        assert!(
            session.begin().is_err(),
            "installer still owns the process gate"
        );
        let failed = guard.finish(&Err("installer unavailable".into()));
        assert_eq!(failed.phase, UpdatePhase::Failed);
        assert_eq!(failed.error_text, "installer unavailable");
        assert!(!failed.can_cancel);
        assert!(session.begin().is_ok(), "errors release the gate for retry");
        assert_eq!(
            session.snapshot().phase,
            UpdatePhase::Idle,
            "dropping a guard still releases the gate"
        );
    }

    #[test]
    fn progress_accumulates_chunks_and_handles_missing_length_without_event_flood() {
        let mut progress = DownloadProgress::default();
        let first = progress
            .report(
                1_048_576,
                Some(4_194_304),
                1_048_576,
                Duration::from_secs(1),
            )
            .unwrap();
        assert!(first.contains("1.0 / 4.0 MiB（25%）"));
        assert!(first.contains("1.00 MiB/s"));
        assert!(progress
            .report(
                2_097_152,
                Some(4_194_304),
                2_097_152,
                Duration::from_millis(1100)
            )
            .is_none());
        let next = progress
            .report(3_145_728, None, 1_048_576, Duration::from_secs(2))
            .unwrap();
        assert!(next.contains("3.0 MiB"));
        assert!(next.contains("总大小未知"));
        assert!(
            next.contains("0.50 MiB/s"),
            "cached bytes must not inflate speed"
        );
        assert!(!next.contains('%'));
    }
}
