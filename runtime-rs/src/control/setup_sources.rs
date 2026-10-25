//! Race a bounded public-file prefix; never probe credential-bearing mirrors.
use super::*;
use futures_util::{StreamExt, stream::FuturesUnordered};

pub(super) fn model_mirror(plan: &DownloadPlan) -> Option<String> {
    if !plan.allow_mirror { return None; }
    static MIRRORS: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../../../tools/inference/managed-model-mirrors.json"))
            .expect("bundled model mirror identities")
    });
    MIRRORS["files"].as_array()?.iter().find(|file| {
        file["sourceUrl"] == plan.url && file["bytes"] == plan.spec.bytes && file["sha256"] == plan.spec.sha256
    })?["mirrorUrl"].as_str().map(str::to_owned)
}

pub(super) async fn order(
    plan: &DownloadPlan, client: &reqwest::Client, cancel: &CancellationToken, sources: &mut Vec<String>,
) -> Result<()> {
    if sources.len() < 2 || plan.spec.bytes < 32 * 1024 * 1024 { return Ok(()); }
    let chosen = {
        let mut attempts = FuturesUnordered::new();
        for source in sources.iter().cloned() {
            let client = client.clone();
            let cancel = cancel.clone();
            let total = plan.spec.bytes;
            attempts.push(async move {
                probe(&client, &source, total, &cancel).await.then_some(source)
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
    if let Some(chosen) = chosen {
        sources.retain(|source| source != &chosen);
        sources.insert(0, chosen);
    }
    Ok(())
}

async fn probe(client: &reqwest::Client, source: &str, total: u64, cancel: &CancellationToken) -> bool {
    let bytes = 128 * 1024;
    let probe = async {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("range", format!("bytes=0-{}", bytes - 1).parse().unwrap());
        let url = url::Url::parse(source).ok()?;
        let mut response = transfer::response(client, url, headers, Duration::from_secs(8), cancel, false).await.ok()?;
        let range = format!("bytes 0-{}/{total}", bytes - 1);
        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT
            || response.headers().get("content-range").and_then(|value| value.to_str().ok()) != Some(range.as_str())
            || transfer::length(&response).ok()?.is_some_and(|length| length != bytes)
        { return None; }
        let mut received = 0;
        while let Some(chunk) = response.chunk().await.ok()? {
            received += chunk.len() as u64;
            if received > bytes { return None; }
        }
        (received == bytes).then_some(())
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => false,
        result = tokio::time::timeout(Duration::from_secs(8), probe) => matches!(result, Ok(Some(()))),
    }
}
