use crate::error::{ApiError, Result};
#[cfg(windows)]
use std::process::Stdio;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio_util::task::TaskTracker;

#[derive(Default)]
pub(crate) struct Processes {
    children: Mutex<HashMap<u64, Child>>,
    next: AtomicU64,
    cleanup: TaskTracker,
    closed: AtomicBool,
}
pub(crate) struct OwnedProcess {
    pool: Arc<Processes>,
    id: u64,
}
impl Processes {
    pub fn spawn(self: &Arc<Self>, command: &mut Command) -> Result<OwnedProcess> {
        let mut children = self.children.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            return Err(ApiError::new(499, "ABORT_ERR", "进程操作已取消"));
        }
        command.kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(unix)]
        command.process_group(0);
        let child = command
            .spawn()
            .map_err(|_| ApiError::new(503, "PROCESS_UNAVAILABLE", "本地进程启动失败"))?;
        child
            .id()
            .ok_or_else(|| ApiError::new(503, "PROCESS_UNAVAILABLE", "本地进程已退出"))?;
        // The OS can reuse a PID after try_wait reaps a child. A handle still
        // held by a caller must never refer to a newer process with that PID.
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        children.insert(id, child);
        Ok(OwnedProcess {
            pool: self.clone(),
            id,
        })
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let children = std::mem::take(&mut *self.children.lock().unwrap());
        for (_, child) in children {
            self.cleanup.spawn(terminate(child));
        }
        self.cleanup.close();
        let _ = tokio::time::timeout(Duration::from_secs(8), self.cleanup.wait()).await;
    }
}
impl OwnedProcess {
    pub fn exited(&self) -> Result<Option<bool>> {
        Ok(self.exit_status()?.map(|status| status.success()))
    }
    pub fn exit_status(&self) -> Result<Option<std::process::ExitStatus>> {
        let mut children = self.pool.children.lock().unwrap();
        let Some(child) = children.get_mut(&self.id) else {
            return Err(ApiError::new(499, "ABORT_ERR", "进程操作已取消"));
        };
        Ok(child.try_wait()?)
    }
    pub async fn stop(&self) -> Result<()> {
        let cleanup = {
            let mut children = self.pool.children.lock().unwrap();
            // Transfer under the same lock used by close. Dropping this caller
            // must not detach Windows tree termination from tracked cleanup.
            children
                .remove(&self.id)
                .map(|child| self.pool.cleanup.spawn(terminate(child)))
        };
        if let Some(cleanup) = cleanup {
            cleanup.await.map_err(|_| {
                ApiError::new(
                    503,
                    "TERMINATION_UNCONFIRMED",
                    "进程清理任务未完成，请检查控制面板。",
                )
            })?
        } else {
            Ok(())
        }
    }
    pub fn take_output(&self) -> (Option<ChildStdout>, Option<ChildStderr>) {
        let mut children = self.pool.children.lock().unwrap();
        let Some(child) = children.get_mut(&self.id) else {
            return (None, None);
        };
        (child.stdout.take(), child.stderr.take())
    }
    pub fn take_input(&self) -> Option<tokio::process::ChildStdin> {
        self.pool
            .children
            .lock()
            .unwrap()
            .get_mut(&self.id)
            .and_then(|child| child.stdin.take())
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if let Some(child) = self.pool.children.lock().unwrap().remove(&self.id) {
            self.pool.cleanup.spawn(terminate(child));
        }
    }
}
async fn terminate(mut child: Child) -> Result<()> {
    if child.try_wait().ok().flatten().is_some() {
        return Ok(());
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        // Only a child handle owned by this runtime supplies the PID; never
        // scan names or terminate unrelated Python/model processes.
        let mut kill = Command::new("taskkill.exe");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), kill.status()).await;
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // spawn() creates a dedicated process group. This negative PID addresses
        // only that owned group, never a system-wide process-name search.
        unsafe {
            kill(-(pid as i32), 9);
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), child.kill()).await;
    tokio::time::timeout(Duration::from_secs(1), child.wait())
        .await
        .map_err(|_| {
            ApiError::new(
                503,
                "TERMINATION_UNCONFIRMED",
                "已请求停止工具，但尚未确认进程退出，请检查控制面板。",
            )
        })??;
    Ok(())
}

pub(crate) fn liveness(pid: u64) -> &'static str {
    if pid == 0 || pid > u32::MAX as u64 {
        return "unknown";
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(process: *mut std::ffi::c_void, exit: *mut u32) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let handle = unsafe { OpenProcess(0x1000, 0, pid as u32) };
        if handle.is_null() {
            return if std::io::Error::last_os_error().raw_os_error() == Some(87) {
                "dead"
            } else {
                "unknown"
            };
        }
        let mut code = 0;
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
        unsafe {
            CloseHandle(handle);
        }
        if ok == 0 {
            "unknown"
        } else if code == 259 {
            "alive"
        } else {
            "dead"
        }
    }
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        if pid > i32::MAX as u64 {
            return "unknown";
        }
        if unsafe { kill(pid as i32, 0) } == 0 {
            "alive"
        } else if std::io::Error::last_os_error().raw_os_error() == Some(3) {
            "dead"
        } else {
            "unknown"
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        "unknown"
    }
}
