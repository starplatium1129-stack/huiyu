use crate::mutex::RecoverMutex;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

// One process may have several windows, each with its own update banner.
pub(super) static SESSION: UpdateSession = UpdateSession(Mutex::new(SessionState {
    active: false,
    cancel: None,
    revision: 0,
    phase: UpdatePhase::Idle,
    version: String::new(),
    status_text: String::new(),
    error_text: String::new(),
    progress: None,
}));

#[derive(Clone, Copy, Default, serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) enum UpdatePhase {
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
    current_version: &'static str,
    phase: UpdatePhase,
    version: String,
    status_text: String,
    error_text: String,
    can_cancel: bool,
    progress: Option<f64>,
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
    progress: Option<f64>,
}

impl SessionState {
    fn snapshot(&self) -> UpdateSnapshot {
        UpdateSnapshot {
            revision: self.revision,
            current_version: env!("CARGO_PKG_VERSION"),
            phase: self.phase,
            version: self.version.clone(),
            status_text: self.status_text.clone(),
            error_text: self.error_text.clone(),
            can_cancel: self.cancel.as_ref().is_some_and(|sender| !*sender.borrow()),
            progress: self.progress,
        }
    }
}

#[derive(Default)]
pub(super) struct UpdateSession(Mutex<SessionState>);
pub(super) struct SessionGuard<'a> {
    session: &'a UpdateSession,
    finished: bool,
}

impl UpdateSession {
    pub(super) fn snapshot(&self) -> UpdateSnapshot {
        self.0
            .recover_lock()
            .snapshot()
    }

    pub(super) fn begin(&self) -> Result<(SessionGuard<'_>, watch::Receiver<bool>), String> {
        let mut state = self.0.recover_lock();
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
        state.progress = None;
        Ok((
            SessionGuard {
                session: self,
                finished: false,
            },
            receiver,
        ))
    }

    pub(super) fn cancel(&self) -> bool {
        let mut state = self.0.recover_lock();
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
    pub(super) fn report(&self, app: &AppHandle, phase: UpdatePhase, version: Option<&str>, text: String, progress: Option<f64>) {
        let snapshot = {
            let mut state = self
                .session
                .0
                .recover_lock();
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
            state.progress = progress;
            state.snapshot()
        };
        let _ = app.emit("desktop-update-state", snapshot);
    }

    pub(super) fn commit_install(&self) -> bool {
        let mut state = self
            .session
            .0
            .recover_lock();
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

    pub(super) fn finish(mut self, result: &Result<bool, String>) -> UpdateSnapshot {
        let mut state = self
            .session
            .0
            .recover_lock();
        // Release the gate before announcing that another explicit attempt is allowed.
        state.active = false;
        state.cancel = None;
        state.progress = None;
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
            .recover_lock();
        state.active = false;
        state.cancel = None;
        state.revision += 1;
        state.phase = UpdatePhase::Idle;
        state.status_text.clear();
    }
}
