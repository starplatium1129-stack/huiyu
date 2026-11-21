//! Race a bounded public-file prefix; never probe credential-bearing mirrors.
use super::*;
use futures_util::{StreamExt, stream::FuturesUnordered};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

#[derive(Default)]
struct HostHealth {
    hosts: HashMap<String, i32>,
}

static HOST_HEALTH: LazyLock<Mutex<HostHealth>> =
    LazyLock::new(|| Mutex::new(HostHealth::default()));

fn host_key(source: &str) -> Option<String> {
    url::Url::parse(source)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
}

pub(super) fn note_failure(source: &str) {
    let Some(host) = host_key(source) else {
        return;
    };
    if let Ok(mut state) = HOST_HEALTH.lock() {
        let entry = state.hosts.entry(host).or_insert(0);
        *entry = (*entry).min(0).saturating_sub(1).max(-8);
    }
}

pub(super) fn note_success(source: &str) {
    let Some(host) = host_key(source) else {
        return;
    };
    if let Ok(mut state) = HOST_HEALTH.lock() {
        let entry = state.hosts.entry(host).or_insert(0);
        *entry = (*entry).max(0).saturating_add(1).min(8);
    }
}

pub(super) fn prioritize(sources: &mut Vec<String>) {
    if sources.len() < 2 {
        return;
    }
    let Ok(state) = HOST_HEALTH.lock() else {
        return;
    };
    let rank = |source: &str| -> i32 {
        let score = host_key(source)
            .and_then(|host| state.hosts.get(&host).copied())
            .unwrap_or(0);
        if score < 0 {
            1
        } else if score > 0 {
            -1
        } else {
            0
        }
    };
    sources.sort_by_key(|source| rank(source));
}

pub(super) fn model_mirror(plan: &DownloadPlan) -> Option<String> {
    if !plan.allow_mirror {
        return None;
    }
    static MIRRORS: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../tools/inference/managed-model-mirrors.json"
        ))
        .expect("bundled model mirror identities")
    });
    MIRRORS["files"].as_array()?.iter().find(|file| {
        file["sourceUrl"] == plan.url
            && file["bytes"] == plan.spec.bytes
            && file["sha256"] == plan.spec.sha256
    })?["mirrorUrl"]
        .as_str()
        .map(str::to_owned)
}

pub(super) async fn order(
    plan: &DownloadPlan,
    client: &reqwest::Client,
    cancel: &CancellationToken,
    sources: &mut Vec<String>,
    retained: u64,
) -> Result<bool> {
    prioritize(sources);
    if sources.len() < 2 || plan.spec.bytes < 32 * 1024 * 1024 {
        return Ok(false);
    }
    let chosen = {
        let mut attempts = FuturesUnordered::new();
        for source in sources.iter().cloned() {
            let client = client.clone();
            let cancel = cancel.clone();
            let total = plan.spec.bytes;
            attempts.push(async move {
                probe(&client, &source, total, retained, &cancel)
                    .await
                    .then_some(source)
            });
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(error(Error::Cancelled)),
            chosen = async {
                while let Some(result) = attempts.next().await {
                    if result.is_some() { return result; }
                }
                None
            } => chosen,
        }
    };
    let Some(chosen) = chosen else {
        return Ok(false);
    };
    note_success(&chosen);
    sources.retain(|source| source != &chosen);
    if chosen != plan.url {
        // A publisher that lost the live probe remains a fallback after the other mirrors.
        sources.rotate_left(1);
    }
    sources.insert(0, chosen);
    Ok(true)
}

async fn probe(
    client: &reqwest::Client,
    source: &str,
    total: u64,
    retained: u64,
    cancel: &CancellationToken,
) -> bool {
    let bytes = 128 * 1024;
    let start = retained.max(1024 * 1024).min(total - bytes);
    let end = start + bytes - 1;
    let probe = async {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("range", format!("bytes={start}-{end}").parse().unwrap());
        let url = url::Url::parse(source).ok()?;
        let mut response =
            transfer::response(client, url, headers, Duration::from_secs(8), cancel, false)
                .await
                .ok()?;
        transfer::partial_range(&response, start, end, total, None).ok()?;
        let mut received = 0;
        while let Some(chunk) = response.chunk().await.ok()? {
            received += chunk.len() as u64;
            if received > bytes {
                return None;
            }
        }
        (received == bytes).then_some(())
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => false,
        result = tokio::time::timeout(Duration::from_secs(8), probe) => matches!(result, Ok(Some(()))),
    }
}
