use super::replies::{ReplyBody, submit_reply};
use super::*;
use std::{net::Ipv4Addr, sync::atomic::AtomicBool};
use tokio::sync::Semaphore;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    #[serde(default)]
    mode: Mode,
    local_ip: Ipv4Addr,
    vm_ip: Ipv4Addr,
    port: u16,
    #[serde(default)]
    nicknames: Nicknames,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum Mode {
    #[default]
    Push,
    Poll,
}

pub(super) struct Endpoint {
    client: Client,
    base: String,
    pub(super) callback: PeerConfig,
    callback_url: String,
    requests: Semaphore,
    unavailable: AtomicBool,
}

pub(super) struct PeerConfig {
    pub(super) peer: tailnet::Peer,
    pub(super) names: Nicknames,
}

impl Config {
    fn peer(&self) -> Result<tailnet::Peer> {
        tailnet::Peer::new(self.local_ip, self.vm_ip, self.port)
    }
}

async fn config(root: &Path) -> Result<Option<Config>> {
    read(&root.join("muse-qq-vm.json")).await
}

pub(super) async fn configured_peer(root: &Path) -> Result<Option<tailnet::Peer>> {
    config(root).await?.map(|config| config.peer()).transpose()
}

pub(super) async fn load(root: &Path) -> Result<Route> {
    let Some(config) = config(root).await? else {
        return Ok(Route::Pull);
    };
    let callback = PeerConfig {
        peer: config.peer()?,
        names: config.nicknames,
    };
    if let Mode::Poll = config.mode {
        return Ok(Route::VmPoll(callback));
    }
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .local_address(std::net::IpAddr::V4(config.local_ip))
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| ApiError::invalid("Muse 虚拟机连接初始化失败"))?;
    Ok(Route::Vm(Endpoint {
        client,
        base: format!("http://{}:{}", config.vm_ip, config.port),
        callback,
        callback_url: format!("http://{}:{}", config.local_ip, config.port),
        requests: Semaphore::new(8),
        unavailable: AtomicBool::new(false),
    }))
}

impl Endpoint {
    pub(super) fn status(&self) -> &'static str {
        if self.unavailable.load(Ordering::Relaxed) {
            "vmUnavailable"
        } else {
            "vmConfigured"
        }
    }

    pub(super) async fn forward(&self, app: &AppState, mailbox: &Mailbox, entry: &Entry) {
        let work = async {
            let mut question = entry.vm_question();
            question["callbackOrigin"] = json!(self.callback_url);
            question["operations"] = operations(true);
            question["operations"]["replyDelivery"] = json!(
                "答复就绪后 POST callbackOrigin 下的 /qq/replies（原 requestKey + text，返回 sent 即完成），也可沿用 GET 轮询。"
            );
            let questions_url = format!("{}/qq/questions", self.base);
            let reply_url = format!("{}/qq/replies/{}", self.base, entry.key);
            let mut accepted = false;
            let reply = loop {
                if !app
                    .host
                    .storage()
                    .is_some_and(|s| s.runtime_epoch() == mailbox.epoch)
                {
                    return;
                }
                if entry.done(&*entry.delivery.lock().await) {
                    return;
                }
                let slot = self
                    .requests
                    .acquire()
                    .await
                    .expect("VM request slots are never closed");
                if accepted {
                    let response = self.client.get(&reply_url).send().await;
                    match response {
                        Ok(response) if response.status() == reqwest::StatusCode::OK => {
                            if let Some(reply) = answer(response, &entry.key).await {
                                self.unavailable.store(false, Ordering::Relaxed);
                                break reply;
                            }
                            self.unavailable.store(true, Ordering::Relaxed);
                        }
                        Ok(response) if response.status() == reqwest::StatusCode::NO_CONTENT => {
                            self.unavailable.store(false, Ordering::Relaxed);
                        }
                        Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {
                            accepted = false
                        }
                        _ => self.unavailable.store(true, Ordering::Relaxed),
                    }
                } else {
                    accepted = self
                        .client
                        .post(&questions_url)
                        .json(&question)
                        .send()
                        .await
                        .is_ok_and(|r| r.status().is_success());
                    self.unavailable.store(!accepted, Ordering::Relaxed);
                }
                drop(slot);
                tokio::time::sleep(Duration::from_secs(3)).await;
            };
            // Keep the exact answer through an ambiguous QQ receipt; QQ deduplicates
            // retries by the original message id and the fixed answer sequence.
            loop {
                match submit_reply(app, mailbox, reply.clone()).await {
                    Err(error)
                        if error.status.is_server_error() || error.status.as_u16() == 429 =>
                    {
                        tokio::time::sleep(Duration::from_secs(3)).await
                    }
                    Err(_) => {
                        self.unavailable.store(true, Ordering::Relaxed);
                        return;
                    }
                    _ => return,
                }
            }
        };
        let remaining = entry.expires_at.saturating_sub(crate::host::now_ms());
        if remaining == 0 {
            return;
        }
        tokio::select! {
            biased;
            _ = mailbox.cancel.cancelled() => {}
            _ = tokio::time::sleep(Duration::from_millis(remaining)) => {}
            _ = work => {}
        }
    }
}

async fn answer(response: reqwest::Response, key: &str) -> Option<ReplyBody> {
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.ok()?;
        if chunk.len() > MESSAGE_JSON_LIMIT - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let reply: ReplyBody = serde_json::from_slice(&bytes).ok()?;
    (reply.request_key == key).then_some(reply)
}
