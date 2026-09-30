use super::*;
use reqwest::Method;
use types::WebUiStatus;

fn names(value: &Value, keys: &[&str]) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            keys.iter().find_map(|key| {
                item[*key]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
            })
        })
        .collect()
}
async fn webui(inner: &Inner, cancel: &CancellationToken) -> WebUiStatus {
    let request = |path| {
        inner.json(
            "webui",
            Method::GET,
            path,
            None,
            Duration::from_secs(3),
            cancel,
        )
    };
    let (options, samplers, schedulers, upscalers, models) = tokio::join!(
        request("/sdapi/v1/options"),
        request("/sdapi/v1/samplers"),
        request("/sdapi/v1/schedulers"),
        request("/sdapi/v1/upscalers"),
        request("/sdapi/v1/sd-models")
    );
    let Ok(options) = options else {
        return WebUiStatus::default();
    };
    let models = models.unwrap_or(Value::Null);
    let keys = ["filename", "title", "model_name", "name"];
    let matched = models.as_array().into_iter().flatten().find(|item| {
        keys.iter().any(|key| {
            item[*key]
                .as_str()
                .is_some_and(resources::is_wai_checkpoint)
        })
    });
    let checkpoint = matched
        .and_then(|item| {
            ["title", "filename", "model_name", "name"]
                .iter()
                .find_map(|key| item[*key].as_str().filter(|s| !s.is_empty()))
        })
        .unwrap_or("");
    let exact = options["sd_model_checkpoint"]
        .as_str()
        .is_some_and(resources::is_wai_checkpoint)
        && resources::is_wai_checkpoint(checkpoint);
    WebUiStatus {
        online: true,
        wai_available: matched.is_some(),
        checkpoint: if exact {
            checkpoint.into()
        } else {
            String::new()
        },
        samplers: names(&samplers.unwrap_or(Value::Null), &["name", "label"]),
        schedulers: names(&schedulers.unwrap_or(Value::Null), &["name", "label"]),
        upscalers: names(&upscalers.unwrap_or(Value::Null), &["name", "label"]),
        models: names(&models, &["title", "filename", "model_name", "name"]),
    }
}
pub(super) async fn webui_status(
    inner: &Inner,
    fresh: bool,
    cancel: &CancellationToken,
) -> WebUiStatus {
    // A fresh admission probe cannot join an older status request. Ordinary
    // concurrent status calls coalesce after the first request refreshes cache.
    let _guard = if fresh {
        None
    } else {
        Some(inner.probe_lock.lock().await)
    };
    if !fresh
        && let Some((at, status)) = &*inner.probe_cache.lock().await
        && at.elapsed() < Duration::from_secs(3)
    {
        return status.clone();
    }
    let generation = inner.probe_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let status = webui(inner, cancel).await;
    if inner.probe_generation.load(Ordering::Relaxed) == generation {
        *inner.probe_cache.lock().await = Some((Instant::now(), status.clone()));
    }
    status
}
pub(super) async fn comfy_status(inner: &Inner, cancel: &CancellationToken) -> bool {
    inner
        .raw_json(
            "comfy",
            Method::GET,
            "/system_stats",
            None,
            Duration::from_millis(2500),
            cancel,
        )
        .await
        .is_ok_and(|(status, _)| (200..300).contains(&status))
}
