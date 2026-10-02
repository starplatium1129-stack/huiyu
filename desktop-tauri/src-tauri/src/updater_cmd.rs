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
}));

#[derive(Default)]
struct SessionState {
    active: bool,
    cancel: Option<watch::Sender<bool>>,
}

#[derive(Default)]
struct UpdateSession(Mutex<SessionState>);
struct SessionGuard<'a>(&'a UpdateSession);

impl UpdateSession {
    fn begin(&self) -> Result<(SessionGuard<'_>, watch::Receiver<bool>), String> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.active {
            return Err("已有更新正在进行，请等待完成或取消下载".into());
        }
        let (cancel, receiver) = watch::channel(false);
        state.active = true;
        state.cancel = Some(cancel);
        Ok((SessionGuard(self), receiver))
    }

    fn cancel(&self) -> bool {
        let state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state
            .cancel
            .as_ref()
            .is_some_and(|sender| sender.send(true).is_ok())
    }
}

impl SessionGuard<'_> {
    fn commit_install(&self) -> bool {
        let mut state = self.0 .0.lock().unwrap_or_else(|error| error.into_inner());
        // Serialize cancellation with the hand-off to the installer. Never install
        // bytes after accepting a cancellation, even if the last chunk won select.
        state.cancel.take().is_some_and(|sender| !*sender.borrow())
    }
}

impl Drop for SessionGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.0 .0.lock().unwrap_or_else(|error| error.into_inner());
        state.active = false;
        state.cancel = None;
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

/// 下载并安装更新，安装器结束后自动重启应用（passive 模式）。
#[tauri::command]
pub async fn desktop_update_install(app: AppHandle) -> Result<bool, String> {
    let (session, mut cancelled) = SESSION.begin()?;
    let _ = app.emit("desktop-update-progress", "正在检查更新…");
    let download = async {
        let Some(update) = check(&app).await? else {
            return Err("当前已是最新版本".to_string());
        };
        let _ = app.emit(
            "desktop-update-progress",
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
            let _ = app.emit("desktop-update-progress", "正在检查已下载缓存并尝试续传…");
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
                    let _ = app.emit("desktop-update-progress", text);
                }
            },
        )
        .await?;
        let _ = app.emit(
            "desktop-update-progress",
            "下载完成，正在校验完整安装包签名…",
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
    let _ = app.emit("desktop-update-progress", "签名校验通过，正在启动安装器…");
    // Tauri exits this process on successful Windows hand-off, so retire only our
    // slot now. An installer launch failure may require downloading again.
    cache.reset("")?;
    update
        .install(bytes)
        .map_err(|error| format!("启动更新安装器失败：{error}"))?;
    app.restart()
}

/// Only cancels checking/downloading. The installer owns the update after hand-off.
#[tauri::command]
pub fn desktop_update_cancel() -> bool {
    SESSION.cancel()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_download_at_a_time_and_cancel_wins_before_install() {
        let session = UpdateSession::default();
        let (guard, receiver) = session.begin().unwrap();
        assert!(session.begin().is_err());
        assert!(session.cancel());
        assert!(*receiver.borrow());
        assert!(!guard.commit_install());
        drop(guard);
        let (guard, _) = session.begin().unwrap();
        assert!(guard.commit_install());
        assert!(
            !session.cancel(),
            "installer cannot be cancelled as a download"
        );
        assert!(
            session.begin().is_err(),
            "installer still owns the process gate"
        );
        drop(guard);
        assert!(
            session.begin().is_ok(),
            "errors/drop release the gate for retry"
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
