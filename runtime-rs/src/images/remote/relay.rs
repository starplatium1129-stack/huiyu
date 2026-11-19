//! Outbound-only Muse connector. The relay can invoke drawing and QQ operations on the
//! dedicated loopback listener. The connector supplies its local credentials only there.
use futures_util::StreamExt;
use reqwest::{Client, Method, Response, Url};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

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
}

const MAX_REPLY: usize = 2 * 1024 * 1024;
const MAX_COMMAND: usize = 384 * 1024;
// The message can contain 3 MiB as base64 plus 64 KiB of JSON. The ticket,
// method and fixed QQ path are added by the relay after it checks that limit.
const MAX_QQ_COMMAND: usize = 4 * 1024 * 1024 + 64 * 1024 + 1024;

fn qq_message(method: &Method, path: &str) -> bool {
    *method == Method::POST && matches!(path, "/api/muse/qq/reply" | "/api/muse/qq/send")
}

pub(super) fn qq_route(method: &Method, path: &str) -> bool {
    qq_message(method, path)
        || (*method == Method::GET && matches!(path, "/api/muse/qq/inbox" | "/api/muse/qq/targets"))
        || (*method == Method::POST && path == "/api/muse/qq/search")
}

fn allowed(method: &Method, path: &str) -> bool {
    if path.len() > 4096 || path.contains(['#', '\\']) || path.bytes().any(|b| b.is_ascii_control())
    {
        return false;
    }
    if qq_route(method, path) {
        return true;
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
                && path.split_once("?part=").is_some_and(|(_, query)| {
                    let (n, count) = query.split_once("&count=").unwrap_or((query, "1"));
                    n.parse::<u32>().is_ok()
                        && count.parse::<u8>().is_ok_and(|v| (1..=16).contains(&v))
                })
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
    media: Client,
    local: Client,
    base: Url,
    agent_token: String,
    port: u16,
    key: String,
}
impl Bridge {
    async fn upload_window(
        &self,
        path: &str,
        headers: &reqwest::header::HeaderMap,
        bytes: &[u8],
    ) -> Result<(), ()> {
        const PART: usize = crate::images::http::PART_BYTES as usize;
        let route = path
            .split('?')
            .next()
            .ok_or(())?
            .split('/')
            .collect::<Vec<_>>();
        let ["", "api", family, "jobs", id, "result"] = route.as_slice() else {
            return Err(());
        };
        let value = |name| headers.get(name).and_then(|v| v.to_str().ok()).ok_or(());
        let offset = value("x-result-offset")?.parse::<usize>().map_err(|_| ())?;
        let digest = value("x-result-sha256")?;
        if bytes.is_empty()
            || offset % PART != 0
            || value("x-part-sha256")? != hex::encode(Sha256::digest(bytes))
        {
            return Err(());
        }
        let per_lane = bytes.len().div_ceil(PART).div_ceil(4) * PART;
        futures_util::future::try_join_all(bytes.chunks(per_lane).enumerate().map(
            |(index, piece)| async move {
                let first = (offset + index * per_lane) / PART;
                let endpoint = self
                    .base
                    .join(&format!("_agent/parts/{family}/{id}/{first}"))
                    .map_err(|_| ())?;
                self.media
                    .post(endpoint)
                    .bearer_auth(&self.agent_token)
                    .header("X-Result-Sha256", digest)
                    .header("X-Part-Sha256", hex::encode(Sha256::digest(piece)))
                    .body(piece.to_owned())
                    .send()
                    .await
                    .map_err(|_| ())?
                    .error_for_status()
                    .map_err(|_| ())?;
                Ok::<(), ()>(())
            },
        ))
        .await?;
        Ok(())
    }
    async fn once(self: &Arc<Self>, qq_tasks: &mut JoinSet<()>) -> Result<(), ()> {
        let request = self
            .cloud
            .post(self.base.join("_agent/next").map_err(|_| ())?)
            .header("X-Muse-Part-Count", "16")
            .header("X-Muse-Parallel", "1")
            .bearer_auth(&self.agent_token)
            .send()
            .await
            .map_err(|_| ())?;
        if request.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(());
        }
        let request = request.error_for_status().map_err(|_| ())?;
        let qq_media = request
            .headers()
            .get("x-muse-qq-media")
            .is_some_and(|v| v == "1");
        let limit = if qq_media {
            MAX_QQ_COMMAND
        } else {
            MAX_COMMAND
        };
        let cmd: Command =
            serde_json::from_slice(&bounded(request, limit).await?).map_err(|_| ())?;
        let ticket = uuid::Uuid::parse_str(&cmd.ticket).map_err(|_| ())?;
        let method = Method::from_bytes(cmd.method.as_bytes()).map_err(|_| ())?;
        if !allowed(&method, &cmd.path) || (qq_media && !qq_message(&method, &cmd.path)) {
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
        if qq_route(&method, &cmd.path) && qq_tasks.len() < 4 {
            // Keep polling while a search or QQ upload awaits its external service.
            let bridge = self.clone();
            qq_tasks.spawn(async move {
                let _ = bridge.forward(cmd, ticket, method).await;
            });
            return Ok(());
        }
        self.forward(cmd, ticket, method).await
    }

    async fn forward(&self, cmd: Command, ticket: uuid::Uuid, method: Method) -> Result<(), ()> {
        let message = qq_message(&method, &cmd.path);
        let search = cmd.path == "/api/muse/qq/search";
        let mut upstream = self
            .local
            .request(
                method,
                format!("http://127.0.0.1:{}{}", self.port, cmd.path),
            )
            .header("X-Token", &self.key)
            .header("Accept-Encoding", "identity");
        if message {
            // A picture needs separate QQ upload and delivery receipts.
            upstream = upstream.timeout(Duration::from_secs(85));
        } else if search {
            upstream = upstream.timeout(Duration::from_secs(35));
        }
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
                if cmd.parallel && status == reqwest::StatusCode::OK {
                    let status = if self
                        .upload_window(&cmd.path, &headers, &bytes)
                        .await
                        .is_ok()
                    {
                        204
                    } else {
                        503
                    };
                    reply
                        .header("X-Upstream-Status", status)
                        .send()
                        .await
                        .map_err(|_| ())?
                        .error_for_status()
                        .map_err(|_| ())?;
                    return Ok(());
                }
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
        make().no_proxy().timeout(Duration::from_secs(25)).build(),
        make().timeout(Duration::from_secs(40)).build(),
        make().http1_only().timeout(Duration::from_secs(30)).build(),
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
        let mut qq_tasks = JoinSet::new();
        loop {
            while qq_tasks.try_join_next().is_some() {}
            tokio::select! { biased; _ = shutdown.cancelled() => break, result = bridge.once(&mut qq_tasks) => {
                if result.is_ok() { retry = 1; continue; }
                if retry == 1 { eprintln!("Muse 中转暂未连通，正在自动重连"); }
            } }
            tokio::select! { _ = shutdown.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(retry)) => {} }
            retry = (retry * 2).min(30);
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
