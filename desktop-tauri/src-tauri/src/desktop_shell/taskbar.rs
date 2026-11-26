use serde::Deserialize;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicI32, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

use super::{authorize, gateway_url, lock, ShellState};

pub(super) struct Notifications {
    next_id: AtomicI32,
    destinations: Mutex<VecDeque<(i32, String)>>,
}

impl Default for Notifications {
    fn default() -> Self {
        Self {
            next_id: AtomicI32::new(10_000),
            destinations: Mutex::new(VecDeque::new()),
        }
    }
}

pub(super) fn initialize(app: &AppHandle) {
    let notify_app = app.clone();
    let _ = app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        let Some(notification) = action.notification() else {
            return;
        };
        let Some(shell) = notify_app.try_state::<ShellState>() else {
            return;
        };
        let destination = {
            let mut notifications = lock(&shell.notifications.destinations);
            notifications
                .iter()
                .position(|(id, _)| *id == notification.id())
                .and_then(|index| notifications.remove(index))
                .map(|(_, route)| route)
        };
        if let Some(destination) = destination {
            let handle = notify_app.clone();
            let _ = notify_app.run_on_main_thread(move || {
                let url = gateway_url(&handle);
                crate::main_shared::open_atelier(&handle, &url, Some(&destination));
            });
        }
    });
}

#[tauri::command]
pub fn desktop_shell_task_progress(
    window: WebviewWindow,
    active: bool,
    progress: Option<u8>,
) -> Result<(), String> {
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    authorize(&window)?;
    if progress.is_some_and(|value| value > 100) {
        return Err("无效的任务进度。".into());
    }
    let status = match (active, progress) {
        (false, _) => ProgressBarStatus::None,
        (true, Some(_)) => ProgressBarStatus::Normal,
        (true, None) => ProgressBarStatus::Indeterminate,
    };
    window
        .set_progress_bar(ProgressBarState {
            status: Some(status),
            progress: progress.map(u64::from),
        })
        .map_err(|_| "无法显示任务栏进度。".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskKind {
    Generation,
    Anima,
    Creative,
    Qwen,
    Keyframe,
    Moss,
    Manga,
    Lineart,
    Video,
    Batch,
}

#[tauri::command]
pub fn desktop_shell_notify_task(
    window: WebviewWindow,
    shell: State<ShellState>,
    task_id: String,
    kind: TaskKind,
) -> Result<(), String> {
    authorize(&window)?;
    if task_id.is_empty()
        || task_id.len() > 160
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("无效的任务标识。".into());
    }
    if window.is_focused().unwrap_or(false) || crate::ui_entry::isolated_profile().is_some() {
        return Ok(());
    }
    let (title, destination) = match kind {
        TaskKind::Moss => (
            "绘图已完成",
            format!("/prompt-builder?engine=moss&job={task_id}"),
        ),
        TaskKind::Qwen => (
            "绘图已完成",
            format!("/prompt-builder?editor=qwen&job={task_id}"),
        ),
        TaskKind::Video => ("视频已完成", format!("/video-studio?job={task_id}")),
        TaskKind::Batch => (
            "任务已完成",
            format!("/video-studio?mode=shots&batch={task_id}"),
        ),
        TaskKind::Keyframe => ("关键帧已完成", "/studio-projects".into()),
        _ => ("绘图已完成", "/gallery?tasks=inbox".into()),
    };
    let id = shell.notifications.next_id.fetch_add(1, Ordering::Relaxed);
    let app = window.app_handle();
    {
        let mut notifications = lock(&shell.notifications.destinations);
        if notifications.len() == 64 {
            notifications.pop_front();
        }
        notifications.push_back((id, destination));
    }
    if app
        .notification()
        .builder()
        .id(id)
        .title(title)
        .body("点击回到绘遇查看结果")
        .show()
        .is_err()
    {
        lock(&shell.notifications.destinations).retain(|(key, _)| *key != id);
        return Err("无法显示系统通知。".into());
    }
    Ok(())
}
