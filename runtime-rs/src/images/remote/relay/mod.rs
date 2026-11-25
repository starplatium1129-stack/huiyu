//! Outbound-only Muse connector. The relay can invoke drawing, chat and voice operations on the
//! dedicated loopback listener. The connector supplies its local credentials only there.
mod client;
mod routes;

use client::Bridge;
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

pub(super) use routes::{
    desktop_chat_route, interrogate_route, ops_direct_route, qq_route, video_direct_route,
    voice_route,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    url: String,
    agent_token: String,
}

impl Config {
    fn address(&self) -> Option<Url> {
        let url = Url::parse(&self.url).ok()?;
        (url.scheme() == "https"
            && url.host_str().is_some()
            && url.path() == "/"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (32..=256).contains(&self.agent_token.len()))
        .then_some(url)
    }
}

pub(crate) async fn configured_address(root: &std::path::Path) -> Option<Url> {
    let bytes = tokio::fs::read(root.join("muse-relay.json")).await.ok()?;
    serde_json::from_slice::<Config>(&bytes).ok()?.address()
}

#[derive(Deserialize)]
struct Command {
    ticket: String,
    method: String,
    path: String,
    body: Option<Value>,
    #[serde(default)]
    parallel: bool,
    #[serde(rename = "inboxWaitSeconds")]
    inbox_wait_seconds: Option<u8>,
}

impl Command {
    fn inbox(&self) -> bool {
        self.method == "GET"
            && matches!(
                self.path.as_str(),
                "/api/muse/desktop/inbox" | "/api/muse/qq/inbox"
            )
    }
}

pub(super) async fn run(
    root: PathBuf,
    port: u16,
    key: String,
    archive: Option<std::sync::Arc<crate::generation::remote_images::Store>>,
    shutdown: CancellationToken,
) {
    let settings = loop {
        match tokio::fs::read(root.join("muse-relay.json")).await {
            Ok(bytes) => break bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tokio::select! { _ = shutdown.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(15)) => {} }
            }
            Err(_) => {
                eprintln!("Muse 中转配置无法读取");
                return;
            }
        }
    };
    let Ok(config) = serde_json::from_slice::<Config>(&settings) else {
        eprintln!("Muse 中转配置格式无效");
        return;
    };
    let Some(base) = config.address() else {
        eprintln!("Muse 中转需要 HTTPS 根地址和有效的出图机密钥");
        return;
    };
    let make = || {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(6))
    };
    let (Ok(local), Ok(cloud), Ok(media)) = (
        crate::http_client::tune_http1(make())
            .no_proxy()
            .pool_max_idle_per_host(16)
            .timeout(Duration::from_secs(25))
            .build(),
        crate::http_client::tune_proxy(make())
            .pool_max_idle_per_host(8)
            .timeout(Duration::from_secs(60))
            .build(),
        crate::http_client::tune_http1(make())
            .http1_only()
            .pool_max_idle_per_host(8)
            .timeout(Duration::from_secs(30))
            .build(),
    ) else {
        return;
    };
    let bridge = Arc::new(Bridge {
        local,
        cloud,
        media,
        base,
        agent_token: config.agent_token,
        port,
        key,
    });
    let poll = async {
        let mut retry = 1;
        let mut failed_since: Option<tokio::time::Instant> = None;
        let mut chat_tasks = JoinSet::new();
        let mut inbox_tasks = JoinSet::new();
        let mut voice_tasks = JoinSet::new();
        let mut interrogate_tasks = JoinSet::new();
        let mut async_tasks = JoinSet::new();
        let mut busy_receipts = JoinSet::new();
        loop {
            let result = tokio::select! { biased;
                _ = shutdown.cancelled() => break,
                result = bridge.once(
                    &mut chat_tasks,
                    &mut inbox_tasks,
                    &mut voice_tasks,
                    &mut interrogate_tasks,
                    &mut async_tasks,
                    &mut busy_receipts,
                ) => result,
            };
            match result {
                Ok(()) => {
                    if let Some(start) = failed_since.take() {
                        eprintln!(
                            "Muse 中转已恢复，距首次失败 {} 秒",
                            start.elapsed().as_secs()
                        );
                    }
                    retry = 1;
                    continue;
                }
                Err(reason) if failed_since.is_none() => {
                    failed_since = Some(tokio::time::Instant::now());
                    eprintln!("Muse 中转暂未连通：{reason}，正在自动重连");
                }
                Err(_) => {}
            }
            tokio::select! { _ = shutdown.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(retry)) => {} }
            retry = (retry * 2).min(15);
        }
    };
    let notify = async {
        let Some(archive) = archive else { return };
        let Ok(endpoint) = bridge.base.join("_agent/finished") else {
            return;
        };
        loop {
            archive.published.notified().await;
            // A missed hint is recovered by the relay's normal batch polling.
            let _ = bridge
                .cloud
                .post(endpoint.clone())
                .bearer_auth(&bridge.agent_token)
                .timeout(Duration::from_secs(5))
                .send()
                .await;
        }
    };
    tokio::select! { _ = shutdown.cancelled() => {}, _ = async { tokio::join!(poll, notify); } => {} }
}
