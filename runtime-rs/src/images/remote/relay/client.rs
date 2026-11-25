use super::{
    Command,
    routes::{
        allowed, desktop_chat_route, is_async_media_command, is_media_part_route,
        is_video_concat_route, qq_message, qq_route, requires_request_key, voice_route,
    },
};
use futures_util::StreamExt;
use reqwest::{Client, Method, RequestBuilder, Response, Url};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::task::JoinSet;

const MAX_REPLY: usize = 2 * 1024 * 1024;
const MAX_COMMAND: usize = 384 * 1024;
const VOICE_SLOTS: usize = 2;
const INTERROGATE_SLOTS: usize = 2;
const ASYNC_MEDIA_SLOTS: usize = 4;
// Matches the Worker's total RPC limit. Even a stalled receipt upload stays bounded.
const MAX_BUSY_RECEIPTS: usize = 32;
// The message can contain 3 MiB as base64 plus 64 KiB of JSON. The ticket,
// method and fixed QQ path are added by the relay after it checks that limit.
const MAX_QQ_COMMAND: usize = 4 * 1024 * 1024 + 64 * 1024 + 1024;
// Interrogate / upscale JSON payloads carry up to 8 MiB decoded (~10.7 MiB base64)
// plus control fields and the relay command envelope.
const MAX_IMAGE_JSON_COMMAND: usize = 12 * 1024 * 1024;
const MAX_VIDEO_INPUT_COMMAND: usize = 4 * 1024 * 1024 + 64 * 1024 + 1024;
const MAX_VIDEO_BATCH_COMMAND: usize = 1024 * 1024 + 64 * 1024;
const CAPABILITIES_HEADER: &str = "interrogate,upscale,video,gallery,health,keyframe,manga";

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

pub(super) struct Bridge {
    pub(super) cloud: Client,
    pub(super) media: Client,
    pub(super) local: Client,
    pub(super) base: Url,
    pub(super) agent_token: String,
    pub(super) port: u16,
    pub(super) key: String,
}

fn network_failure(error: reqwest::Error) -> String {
    if let Some(status) = error.status() {
        format!("HTTP {}", status.as_u16())
    } else if error.is_timeout() {
        "请求超时".into()
    } else if error.is_connect() {
        "连接建立失败".into()
    } else {
        "传输中断".into()
    }
}

// Retry only the buffered receipt addressed to the same relay ticket. The local
// QQ send or drawing submission which produced it must run exactly once here.
async fn send_receipt(request: RequestBuilder) -> Result<(), String> {
    let retry = request.try_clone();
    let response = request.send().await.and_then(Response::error_for_status);
    if let Err(error) = response {
        let transient = match error.status() {
            Some(status) => matches!(status.as_u16(), 408 | 502 | 503 | 504),
            None => !error.is_builder(),
        };
        if transient && let Some(retry) = retry {
            tokio::time::sleep(Duration::from_millis(250)).await;
            retry
                .send()
                .await
                .and_then(Response::error_for_status)
                .map_err(|error| format!("回执重送失败：{}", network_failure(error)))?;
        } else {
            return Err(format!("回执失败：{}", network_failure(error)));
        }
    }
    Ok(())
}

impl Bridge {
    fn receipt(&self, ticket: uuid::Uuid) -> Result<RequestBuilder, String> {
        let endpoint = self
            .base
            .join(&format!("_agent/reply/{ticket}"))
            .map_err(|_| "中转回执地址无效")?;
        Ok(self.cloud.post(endpoint).bearer_auth(&self.agent_token))
    }

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
                let part_digest = hex::encode(Sha256::digest(piece));
                let payload = piece.to_owned();
                for attempt in 0..2 {
                    let result = self
                        .media
                        .post(endpoint.clone())
                        .bearer_auth(&self.agent_token)
                        .header("X-Result-Sha256", digest)
                        .header("X-Part-Sha256", &part_digest)
                        .body(payload.clone())
                        .send()
                        .await
                        .and_then(Response::error_for_status);
                    match result {
                        Ok(_) => return Ok::<(), ()>(()),
                        Err(error) => {
                            let transient = match error.status() {
                                Some(status) => matches!(status.as_u16(), 408 | 502 | 503 | 504),
                                None => !error.is_builder(),
                            };
                            if attempt == 0 && transient {
                                tokio::time::sleep(Duration::from_millis(250)).await;
                                continue;
                            }
                            return Err(());
                        }
                    }
                }
                Err(())
            },
        ))
        .await?;
        Ok(())
    }

    pub(super) async fn once(
        self: &Arc<Self>,
        chat_tasks: &mut JoinSet<()>,
        inbox_tasks: &mut JoinSet<()>,
        voice_tasks: &mut JoinSet<()>,
        interrogate_tasks: &mut JoinSet<()>,
        async_tasks: &mut JoinSet<()>,
        busy_receipts: &mut JoinSet<()>,
    ) -> Result<(), String> {
        while busy_receipts.try_join_next().is_some() {}
        if busy_receipts.len() >= MAX_BUSY_RECEIPTS {
            let _ = busy_receipts.join_next().await;
        }
        let request = self
            .cloud
            .post(self.base.join("_agent/next").map_err(|_| "取信地址无效")?)
            .header("X-Muse-Part-Count", "16")
            .header("X-Muse-Parallel", "1")
            .header("X-Muse-Voice", "1")
            .header("X-Muse-Options", "1")
            .header("X-Muse-Capabilities", CAPABILITIES_HEADER)
            .bearer_auth(&self.agent_token)
            .send();
        // The relay holds an idle command poll for at most 15 seconds. Bound the
        // wait for headers without shortening the timeout for a large body.
        let request = tokio::time::timeout(Duration::from_secs(22), request)
            .await
            .map_err(|_| "中转取信等待响应超时")?
            .map_err(network_failure)?;
        if request.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(());
        }
        let request = request.error_for_status().map_err(network_failure)?;
        let qq_media = request
            .headers()
            .get("x-muse-qq-media")
            .is_some_and(|v| v == "1");
        let body_class = request
            .headers()
            .get("x-muse-body-class")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let limit = if qq_media {
            MAX_QQ_COMMAND
        } else {
            match body_class.as_deref() {
                Some("image-json") => MAX_IMAGE_JSON_COMMAND,
                Some("video-input") => MAX_VIDEO_INPUT_COMMAND,
                Some("video-batch") => MAX_VIDEO_BATCH_COMMAND,
                _ => MAX_COMMAND,
            }
        };
        let bytes = bounded(request, limit)
            .await
            .map_err(|_| "取信响应中断或超过大小上限")?;
        let mut cmd: Command = serde_json::from_slice(&bytes).map_err(|_| "取信响应格式无效")?;
        let ticket = uuid::Uuid::parse_str(&cmd.ticket).map_err(|_| "取信票据无效")?;
        let method = Method::from_bytes(cmd.method.as_bytes()).map_err(|_| "取信操作无效")?;
        let route = cmd.path.split('?').next().unwrap_or("");
        let body_class_ok = match body_class.as_deref() {
            None => true,
            Some("image-json") => {
                method == Method::POST
                    && matches!(
                        route,
                        crate::interrogate::muse::INTERROGATE_PATH
                            | super::super::muse::upscale::UPSCALE_PATH
                    )
            }
            Some("video-input") => method == Method::POST && route == "/api/muse/video/inputs",
            Some("video-batch") => method == Method::POST && route == "/api/muse/video/batches",
            Some(_) => false,
        };
        if !allowed(&method, &cmd.path)
            || (qq_media && !qq_message(&method, &cmd.path))
            || !body_class_ok
        {
            return Err("中转操作不在网关允许范围内".into());
        }
        if requires_request_key(&method, route)
            && !cmd
                .body
                .as_ref()
                .and_then(|body| body["requestKey"].as_str())
                .is_some_and(crate::generation::receipts::valid_request_key)
        {
            return Err("中转操作缺少有效的请求编号".into());
        }
        let inbox = cmd.inbox();
        if voice_route(&method, &cmd.path) {
            while voice_tasks.try_join_next().is_some() {}
            if voice_tasks.len() < VOICE_SLOTS {
                let bridge = self.clone();
                voice_tasks.spawn(async move {
                    if let Err(reason) = bridge.forward(cmd, ticket, method).await {
                        eprintln!("Muse 中转语音转发失败：{reason}");
                    }
                });
            } else {
                let reply = self.receipt(ticket)?
                    .timeout(Duration::from_secs(3))
                    .header("X-Upstream-Status", 429)
                    .header("Retry-After", "3")
                    .json(&serde_json::json!({"ok": false, "code": "MUSE_VOICE_BUSY", "message": "主力机语音繁忙，请稍后重试"}));
                busy_receipts.spawn(async move {
                    if let Err(reason) = send_receipt(reply).await {
                        eprintln!("Muse 中转语音限流回执失败：{reason}");
                    }
                });
            }
            return Ok(());
        }
        if method == Method::POST && route == crate::interrogate::muse::INTERROGATE_PATH {
            while interrogate_tasks.try_join_next().is_some() {}
            if interrogate_tasks.len() < INTERROGATE_SLOTS {
                let bridge = self.clone();
                interrogate_tasks.spawn(async move {
                    if let Err(reason) = bridge.forward(cmd, ticket, method).await {
                        eprintln!("Muse 中转反推转发失败：{reason}");
                    }
                });
            } else {
                let reply = self.receipt(ticket)?
                    .timeout(Duration::from_secs(3))
                    .header("X-Upstream-Status", 429)
                    .header("Retry-After", "3")
                    .json(&serde_json::json!({"ok": false, "code": "MUSE_INTERROGATE_BUSY", "message": "主力机图像反推繁忙，请稍后重试"}));
                busy_receipts.spawn(async move {
                    if let Err(reason) = send_receipt(reply).await {
                        eprintln!("Muse 中转反推限流回执失败：{reason}");
                    }
                });
            }
            return Ok(());
        }
        if is_async_media_command(&method, route) {
            while async_tasks.try_join_next().is_some() {}
            if async_tasks.len() < ASYNC_MEDIA_SLOTS {
                let bridge = self.clone();
                async_tasks.spawn(async move {
                    if let Err(reason) = bridge.forward(cmd, ticket, method).await {
                        eprintln!("Muse 中转媒体转发失败：{reason}");
                    }
                });
            } else {
                let reply = self.receipt(ticket)?
                    .timeout(Duration::from_secs(3))
                    .header("X-Upstream-Status", 429)
                    .header("Retry-After", "2")
                    .json(&serde_json::json!({"ok": false, "code": "MUSE_RELAY_BUSY", "message": "主力机媒体通道繁忙，请稍后重试"}));
                busy_receipts.spawn(async move {
                    if let Err(reason) = send_receipt(reply).await {
                        eprintln!("Muse 中转媒体限流回执失败：{reason}");
                    }
                });
            }
            return Ok(());
        }
        while inbox_tasks.try_join_next().is_some() {}
        while chat_tasks.try_join_next().is_some() {}
        if inbox && inbox_tasks.len() >= 4 {
            // Extra readers get a snapshot so the command pump can accept replies.
            cmd.inbox_wait_seconds = Some(0);
            return self.forward(cmd, ticket, method).await;
        }
        if inbox
            || ((qq_route(&method, &cmd.path) || desktop_chat_route(&method, &cmd.path))
                && chat_tasks.len() < 4)
        {
            // Waiting for an inbox must leave room for replies, searches and QQ uploads.
            let tasks = if inbox { inbox_tasks } else { chat_tasks };
            let bridge = self.clone();
            tasks.spawn(async move {
                if let Err(reason) = bridge.forward(cmd, ticket, method).await {
                    eprintln!("Muse 中转聊天转发失败：{reason}");
                }
            });
            return Ok(());
        }
        self.forward(cmd, ticket, method).await
    }

    async fn forward(
        &self,
        cmd: Command,
        ticket: uuid::Uuid,
        method: Method,
    ) -> Result<(), String> {
        let route = cmd.path.split('?').next().unwrap_or("");
        let message = qq_message(&method, &cmd.path);
        let inbox = cmd.inbox();
        let search = cmd.path == "/api/muse/qq/search";
        let is_head = method == Method::HEAD;
        let is_interrogate =
            method == Method::POST && route == crate::interrogate::muse::INTERROGATE_PATH;
        let is_concat = method == Method::POST && is_video_concat_route(route);
        let is_large_upload = method == Method::POST
            && matches!(
                route,
                super::super::muse::upscale::UPSCALE_PATH | "/api/muse/video/inputs"
            );
        let is_media_part = is_media_part_route(route);
        let mut upstream = self
            .local
            .request(
                method,
                format!("http://127.0.0.1:{}{}", self.port, cmd.path),
            )
            .header("X-Token", &self.key)
            .header("Accept-Encoding", "identity");
        if inbox && let Some(wait) = cmd.inbox_wait_seconds {
            let wait = wait.min(crate::chat::muse::MAX_INBOX_WAIT_SECONDS);
            upstream = upstream
                .header("Prefer", format!("wait={wait}"))
                .timeout(Duration::from_secs(u64::from(wait) + 10));
        }
        if is_concat {
            upstream = upstream.timeout(Duration::from_secs(120));
        } else if is_interrogate {
            // Allow PixAI + remote vision assist + layout generation.
            upstream = upstream.timeout(Duration::from_secs(105));
        } else if message || cmd.path == "/api/muse/voice/synthesize" {
            // Allow for QQ uploads or a cold voice model.
            upstream = upstream.timeout(Duration::from_secs(85));
        } else if is_large_upload {
            upstream = upstream.timeout(Duration::from_secs(65));
        } else if is_media_part {
            upstream = upstream.timeout(Duration::from_secs(40));
        } else if search {
            upstream = upstream.timeout(Duration::from_secs(35));
        }
        if let Some(body) = cmd.body {
            upstream = upstream.json(&body);
        }
        let mut reply = self.receipt(ticket)?;
        let payload = match upstream.send().await {
            Ok(response) => {
                let status = response.status();
                let headers = response.headers().clone();
                let body_bytes = if is_head {
                    Ok(Vec::new())
                } else {
                    bounded(response, MAX_REPLY).await
                };
                if let Ok(bytes) = body_bytes {
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
                        return send_receipt(reply.header("X-Upstream-Status", status)).await;
                    }
                    for name in [
                        "content-type",
                        "x-result-mime",
                        "x-result-offset",
                        "x-result-bytes",
                        "x-result-sha256",
                        "x-part-sha256",
                        "x-part-bytes",
                        "etag",
                        "accept-ranges",
                        "retry-after",
                    ] {
                        if let Some(value) = headers.get(name) {
                            reply = reply.header(name, value);
                        }
                    }
                    if let Some(value) = headers.get("content-length") {
                        reply = reply.header("x-upstream-content-length", value);
                    }
                    Ok((status.as_u16(), bytes))
                } else {
                    Err("网关响应中断或超过大小上限".into())
                }
            }
            Err(error) => Err(network_failure(error)),
        };
        let (status, bytes) = payload.unwrap_or_else(|failure| {
            if inbox {
                eprintln!("Muse 中转本机取信失败 path={}：{failure}", cmd.path);
            }
            (503, br#"{"ok":false,"code":"MUSE_LOCAL_UNAVAILABLE","message":"Retry the same request or use a smaller catalog page."}"#.to_vec())
        });
        send_receipt(reply.header("X-Upstream-Status", status).body(bytes)).await
    }
}
