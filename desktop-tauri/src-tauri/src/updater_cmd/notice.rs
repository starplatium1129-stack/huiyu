use crate::{mutex::RecoverMutex, state::AppState};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

static WRITE: Mutex<()> = Mutex::new(());
const REMIND_SECONDS: u64 = 24 * 60 * 60;

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preference {
    skip: Option<String>,
    remind_version: Option<String>,
    remind_after: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice { Later, Skip }

fn file(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().paths.config_root.join("desktop-update-notice.json")
}

fn read(path: &std::path::Path) -> Preference {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

pub(super) fn suppressed(app: &AppHandle, version: &str) -> bool {
    let pref = read(&file(app));
    pref.skip.as_deref() == Some(version) || (pref.remind_version.as_deref() == Some(version)
        && pref.remind_after.is_some_and(|until| until > now()))
}

pub(super) fn reminder_delay(app: &AppHandle) -> Option<Duration> {
    let pref = read(&file(app));
    let version = pref.remind_version?;
    if pref.skip.as_deref() == Some(version.as_str()) { return None; }
    let seconds = pref.remind_after?.checked_sub(now())?;
    (seconds > 0).then(|| Duration::from_secs(seconds.min(REMIND_SECONDS)))
}

pub(super) fn record(app: &AppHandle, version: String, choice: Choice) -> Result<(), String> {
    if version.len() > 64 || semver::Version::parse(&version).is_err() {
        return Err("更新版本无效".into());
    }
    let _guard = WRITE.recover_lock();
    let path = file(app);
    let mut pref = read(&path);
    match choice {
        Choice::Skip => pref.skip = Some(version),
        Choice::Later => {
            pref.remind_version = Some(version);
            pref.remind_after = Some(now() + REMIND_SECONDS);
        }
    }
    let value = serde_json::to_value(pref).map_err(|_| "无法保存更新提醒设置")?;
    if !crate::window_state::try_save_json_atomic(&path, &value) {
        return Err("无法保存更新提醒设置".into());
    }
    Ok(())
}
