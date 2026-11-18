//! Outbound-only Muse connector. The relay can invoke drawing operations on the
//! dedicated loopback listener, never choose a destination or supply local credentials.
use futures_util::StreamExt;
use reqwest::{Client, Method, Response, Url};
use serde::Deserialize;
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    url: String,
    agent_token: String,
}

#[derive(Deserialize)]
struct Command {
    ticket: String,
    method: String,
    path: String,
    body: Option<Value>,
}

const MAX_REPLY: usize = 2 * 1024 * 1024;

fn allowed(method: &Method, path: &str) -> bool {
    if path.len() > 4096 || path.contains(['#', '\\']) || path.bytes().any(|b| b.is_ascii_control())
    {
        return false;
    }
    let route = path.split('?').next().unwrap_or("");
    let parts: Vec<_> = route.split('/').collect();
    let key = |s: &str| {
        !s.is_empty()
            && s.len() <= 180
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    };
    match parts.as_slice() {
        ["", "api", "muse", "jobs"] => *method == Method::POST || *method == Method::GET,
        ["", "api", "muse", "batches"] => *method == Method::POST,
        ["", "api", "muse", "guide" | "queue" | "catalog"] => *method == Method::GET,
        [
            "",
            "api",
            "muse",
            "catalog",
            "scene" | "blueprint" | "outfit",
            ids @ ..,
        ] => *method == Method::GET && !ids.is_empty() && ids.iter().all(|id| key(id)),
        ["", "api", "muse", "batches", ids @ ..] => {
            (*method == Method::GET || *method == Method::DELETE)
                && (1..=2).contains(&ids.len())
                && ids.iter().all(|id| key(id))
        }
        [
            "",
            "api",
            "anima" | "moss" | "qwen" | "creative",
            "jobs" | "requests",
            id,
        ] => (*method == Method::GET || *method == Method::DELETE) && key(id),
        [
            "",
            "api",
            "anima" | "moss" | "qwen" | "creative",
            "jobs",
            id,
            "result",
        ] => {
            *method == Method::GET
                && id.len() == 32
                && id.bytes().all(|b| b.is_ascii_hexdigit())
                && path
                    .split_once("?part=")
                    .is_some_and(|(_, n)| n.parse::<u32>().is_ok())
        }
        _ => false,
    }
}

async fn bounded(response: Response, limit: usize) -> Result<Vec<u8>, ()> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if chunk.len() > limit - bytes.len() {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

struct Bridge {
    cloud: Client,
    local: Client,
    base: Url,
    agent_token: String,
    port: u16,
    key: String,
}
impl Bridge {
    async fn once(&self) -> Result<(), ()> {
        let request = self
            .cloud
            .post(self.base.join("_agent/next").map_err(|_| ())?)
            .bearer_auth(&self.agent_token)
            .send()
            .await
            .map_err(|_| ())?;
        if request.status() == reqwest::StatusCode::NO_CONTENT {
            tokio::time::sleep(Duration::from_secs(2)).await;
            return Ok(());
        }
        let request = request.error_for_status().map_err(|_| ())?;
        let cmd: Command =
            serde_json::from_slice(&bounded(request, 384 * 1024).await?).map_err(|_| ())?;
        let ticket = uuid::Uuid::parse_str(&cmd.ticket).map_err(|_| ())?;
        let method = Method::from_bytes(cmd.method.as_bytes()).map_err(|_| ())?;
        if !allowed(&method, &cmd.path) {
            return Err(());
        }
        if method == Method::POST
            && !cmd
                .body
                .as_ref()
                .and_then(|body| body["requestKey"].as_str())
                .is_some_and(|key| {
                    !key.is_empty()
                        && key.len() <= 160
                        && key
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                })
        {
            return Err(());
        }
        let mut upstream = self
            .local
            .request(
                method,
                format!("http://127.0.0.1:{}{}", self.port, cmd.path),
            )
            .header("X-Token", &self.key)
            .header("Accept-Encoding", "identity");
        if let Some(body) = cmd.body {
            upstream = upstream.json(&body);
        }
        let mut reply = self
            .cloud
            .post(
                self.base
                    .join(&format!("_agent/reply/{ticket}"))
                    .map_err(|_| ())?,
            )
            .bearer_auth(&self.agent_token);
        let mut payload = None;
        if let Ok(response) = upstream.send().await {
            let status = response.status();
            let headers = response.headers().clone();
            if let Ok(bytes) = bounded(response, MAX_REPLY).await {
                for name in [
                    "content-type",
                    "x-result-offset",
                    "x-result-bytes",
                    "x-result-sha256",
                    "x-part-sha256",
                    "retry-after",
                ] {
                    if let Some(value) = headers.get(name) {
                        reply = reply.header(name, value);
                    }
                }
                payload = Some((status.as_u16(), bytes));
            }
        }
        let (status, bytes) = payload.unwrap_or_else(|| (503, br#"{"ok":false,"code":"MUSE_LOCAL_UNAVAILABLE","message":"Retry the same request or use a smaller catalog page."}"#.to_vec()));
        reply
            .header("X-Upstream-Status", status)
            .body(bytes)
            .send()
            .await
            .map_err(|_| ())?
            .error_for_status()
            .map_err(|_| ())?;
        Ok(())
    }
}

pub(super) async fn run(root: PathBuf, port: u16, key: String, shutdown: CancellationToken) {
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
    let Ok(base) = Url::parse(&config.url) else {
        eprintln!("Muse 中转地址无效");
        return;
    };
    if base.scheme() != "https"
        || base.host_str().is_none()
        || base.path() != "/"
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || !(32..=256).contains(&config.agent_token.len())
    {
        eprintln!("Muse 中转需要 HTTPS 根地址和有效的出图机密钥");
        return;
    }
    let make = || {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(6))
    };
    let (Ok(local), Ok(cloud)) = (
        make().no_proxy().timeout(Duration::from_secs(25)).build(),
        make().timeout(Duration::from_secs(40)).build(),
    ) else {
        return;
    };
    let bridge = Bridge {
        local,
        cloud,
        base,
        agent_token: config.agent_token,
        port,
        key,
    };
    let mut retry = 1;
    loop {
        tokio::select! { biased; _ = shutdown.cancelled() => break, result = bridge.once() => {
            if result.is_ok() { retry = 1; continue; }
            if retry == 1 { eprintln!("Muse 中转暂未连通，正在自动重连"); }
        } }
        tokio::select! { _ = shutdown.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(retry)) => {} }
        retry = (retry * 2).min(30);
    }
}
