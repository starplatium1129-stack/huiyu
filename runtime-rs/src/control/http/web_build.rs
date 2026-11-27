use super::*;
use std::{fs, path::Path};

#[derive(Default)]
pub(in crate::control) struct Cache {
    checked: Option<Instant>,
    snapshot: Option<Value>,
    refreshing: bool,
    generation: u64,
}

pub(super) fn current(service: &ControlService) -> Option<Value> {
    service.build_cache.lock().unwrap().snapshot.clone()
}

pub(super) async fn snapshot_ready(service: &Arc<ControlService>) -> Option<Value> {
    let existing = {
        let mut cache = service.build_cache.lock().unwrap();
        if let Some(snapshot) = cache.snapshot.clone() {
            if !cache.refreshing
                && cache
                    .checked
                    .is_none_or(|at| at.elapsed() >= Duration::from_secs(30))
                && !service.shutdown.is_cancelled()
            {
                cache.refreshing = true;
                let generation = cache.generation;
                let task = service.clone();
                service
                    .tasks
                    .spawn(async move { refresh(&task, generation).await });
            }
            return Some(snapshot);
        }
        cache.generation
    };
    // Populate once on cold start so `/api/status` never flashes `"webBuild": null`.
    let task = service.clone();
    service
        .tasks
        .spawn(async move { refresh(&task, existing).await })
        .await
        .ok()
        .flatten()
}

pub(super) async fn after_build(service: &Arc<ControlService>) -> Option<Value> {
    let generation = {
        let mut cache = service.build_cache.lock().unwrap();
        cache.generation += 1;
        cache.refreshing = true;
        cache.generation
    };
    // A client disconnect must not leave the refresh flag set indefinitely.
    let task = service.clone();
    service
        .tasks
        .spawn(async move { refresh(&task, generation).await })
        .await
        .ok()
        .flatten()
}

async fn refresh(service: &ControlService, generation: u64) -> Option<Value> {
    let root = service.config.app_root.clone();
    let packaged = service.config.is_packaged();
    let value = tokio::task::spawn_blocking(move || scan(&root, packaged))
        .await
        .ok();
    let mut cache = service.build_cache.lock().unwrap();
    if cache.generation == generation {
        if value.is_some() {
            cache.snapshot = value;
        }
        cache.checked = Some(Instant::now());
        cache.refreshing = false;
    }
    cache.snapshot.clone()
}

fn scan(root: &Path, packaged: bool) -> Value {
    let built = fs::metadata(root.join("dist/_guest/try.html"))
        .ok()
        .and_then(|stat| stat.modified().ok());
    let mut newest = UNIX_EPOCH;
    if !packaged {
        let mut stack = ["src", "public", "index.html", "try.html", "vite.config.ts"]
            .map(|path| root.join(path))
            .to_vec();
        for _ in 0..50_000 {
            let Some(path) = stack.pop() else { break };
            let Ok(stat) = fs::symlink_metadata(&path) else {
                continue;
            };
            if stat.file_type().is_symlink() {
                continue;
            }
            if stat.is_dir() {
                if let Ok(entries) = fs::read_dir(path) {
                    stack.extend(entries.filter_map(|entry| entry.ok().map(|entry| entry.path())));
                }
            } else if let Ok(modified) = stat.modified() {
                newest = newest.max(modified);
            }
        }
    }
    let timestamp = |time: SystemTime| {
        chrono::DateTime::from_timestamp_millis(
            time.duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        )
        .map(|time| time.to_rfc3339())
    };
    json!({
        "distReady": built.is_some(),
        "builtAt": built.and_then(timestamp),
        "stale": built.is_some_and(|time| newest.duration_since(time).is_ok_and(|age| age > Duration::from_secs(5))),
        "sourceNewest": (!packaged).then(|| timestamp(newest)).flatten(),
    })
}
