use super::*;
use crate::upstream::progress::{ProgressMonitor, ProgressUpdate};
use tokio::sync::broadcast::error::RecvError;

pub(in crate::generation) fn start(inner: &Arc<Inner>, client_id: &str) -> Result<ProgressMonitor> {
    let monitor = ProgressMonitor::new(&inner.config.comfy_host, client_id)?;
    let mut events = monitor.subscribe();
    let weak = Arc::downgrade(inner);
    let cancel = inner.cancel.clone();
    inner.tasks.spawn(async move {
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => return,
                result = events.recv() => match result {
                    Ok(event) if event.event != "connection_lost" => Some(event),
                    Ok(_) | Err(RecvError::Lagged(_)) => None,
                    Err(RecvError::Closed) => return,
                }
            };
            let Some(inner) = weak.upgrade() else { return };
            update(&inner, event.as_deref()).await;
        }
    });
    Ok(monitor)
}

async fn update(inner: &Inner, event: Option<&ProgressUpdate>) {
    let Some(initialized) = inner.initialized.get() else {
        return;
    };
    let ids = {
        let monitor = initialized.progress.lock().unwrap();
        let Some(monitor) = monitor.as_ref() else {
            return;
        };
        monitor.watched_jobs(event.map(|event| event.prompt_id.as_str()))
    };
    for id in ids {
        let job = inner.state.lock().await.jobs.get(&id).cloned();
        let Some(job) = job else { continue };
        let mut state = job.state.lock().await;
        if state.settled {
            continue;
        }
        if let Some(event) = event {
            if state.upstream_id != event.prompt_id {
                continue;
            }
            state.progress = event.progress;
            state.current_node.clone_from(&event.current_node);
            state.progress_text.clone_from(&event.progress_text);
            state.progress_live = true;
            state.execution_started = true;
            if !event.terminal_hint() {
                continue;
            }
            state.history_finishing = Some(tokio::time::Instant::now() + Duration::from_secs(5));
        } else {
            state.progress_live = false;
            state.progress = None;
            state.progress_text = "进度连接暂时中断，正在核对任务…".into();
        }
        // A hint wakes history polling. Only the HTTP result can settle the job.
        state.history_urgent = true;
        job.notify.notify_one();
    }
}
