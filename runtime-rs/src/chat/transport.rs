use super::{Duration, Error, Result};
use axum::body::Bytes;
use futures_util::StreamExt;
use std::{
    env,
    net::{IpAddr, Ipv6Addr, SocketAddr},
};
use url::Url;

pub(super) struct Transport {
    trusted: reqwest::Client,
}
pub(super) struct Request<'a> {
    pub body: Option<Bytes>,
    pub key: &'a str,
    pub session_id: Option<&'a str>,
    pub public_only: bool,
    pub idle: Duration,
    pub total: Duration,
    pub accept: &'a str,
}
fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(concat!("Huiyu/", env!("CARGO_PKG_VERSION")))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(32)
        .tcp_keepalive(Duration::from_secs(15))
}
impl Transport {
    pub fn new() -> Self {
        Self {
            trusted: builder()
                .proxy(reqwest::Proxy::custom(proxy))
                .build()
                .expect("Initialize chat HTTP client"),
        }
    }
    pub async fn send(&self, target: Url, options: Request<'_>) -> Result<reqwest::Response> {
        if !["http", "https"].contains(&target.scheme())
            || !target.username().is_empty()
            || target.password().is_some()
        {
            return Err(Error::invalid("Invalid upstream URL"));
        }
        let public;
        let client = if options.public_only {
            let address = tokio::time::timeout(options.idle, public_address(&target))
                .await
                .map_err(|_| timeout())??;
            public = builder()
                .pool_max_idle_per_host(0)
                .resolve(target.host_str().unwrap(), address)
                .build()
                .map_err(|_| unavailable())?;
            &public
        } else {
            &self.trusted
        };
        let opencode = super::validation::vendor(&target) == "opencode";
        let mut request = if let Some(body) = options.body {
            client
                .post(target)
                .header("content-type", "application/json")
                .body(body)
        } else {
            client.get(target)
        };
        if !options.key.is_empty() {
            request = request.bearer_auth(options.key);
        }
        if opencode && let Some(session_id) = options.session_id {
            request = request.header("x-opencode-session", session_id);
        }
        tokio::time::timeout(
            options.idle,
            request
                .header("accept", options.accept)
                .timeout(options.total)
                .send(),
        )
        .await
        .map_err(|_| timeout())?
        .map_err(network_error)
    }
}

pub(super) async fn bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Error::stream(
            "RESPONSE_TOO_LARGE",
            "Upstream response exceeded the size limit",
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(Error::stream(
                "RESPONSE_TOO_LARGE",
                "Upstream response exceeded the size limit",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub(super) async fn success(
    response: reqwest::Response,
    limit: usize,
    message: &str,
) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let vendor = super::validation::vendor(response.url());
    // Providers may echo authorization headers, keys, or credential-bearing URLs.
    // Only recognize known error types; never publish/log upstream error bodies.
    let bytes = bounded(response, limit).await?;
    let body = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default();
    Err(upstream_error(status, &vendor, body.get("error").unwrap_or(&body), message))
}

// These are local messages selected by documented identifiers, never upstream prose.
pub(super) fn upstream_error(status: u16, vendor: &str, error: &serde_json::Value, context: &str) -> Error {
    let identified = [error["code"].as_str(), error["type"].as_str()].into_iter().flatten()
        .find_map(|kind| match (vendor, kind) {
            ("opencode", "FreeTierError") => Some(("OPENCODE_FREE_TIER_RESTRICTED", "免费层限制了客户端或使用场景，请核对该模型的免费层使用要求。")),
            ("opencode", "MissingSessionID") => Some(("OPENCODE_SESSION_REQUIRED", "服务未收到会话标识，请更新绘遇并确认代理保留 x-opencode-session 请求头。")),
            ("qwen", "Arrearage") => Some(("UPSTREAM_QUOTA", "百炼账户欠费，请检查账户余额。")),
            ("qwen", "AccessDenied.Unpurchased") => Some(("UPSTREAM_PERMISSION", "账号尚未开通百炼服务，请到百炼控制台开通。")),
            ("qwen", "Model.AccessDenied" | "Workspace.AccessDenied") => Some(("UPSTREAM_PERMISSION", "密钥没有所选模型或业务空间的权限，请核对地域和业务空间授权。")),
            ("qwen", "Endpoint.AccessDenied") => Some(("UPSTREAM_MODEL", "模型端点不可访问，请检查模型是否下线及业务空间权限。")),
            ("qwen", "AllocationQuota.FreeTierOnly") => Some(("UPSTREAM_QUOTA", "模型免费额度已耗尽，请到百炼控制台确认额度及用完即停设置。")),
            ("qwen", "insufficient_quota" | "Throttling.AllocationQuota") => Some(("UPSTREAM_RATE_LIMIT", "请求或 Token 速率达到配额，请稍后重试或调整限流额度。")),
            ("kimi", "permission_denied_error") => Some(("UPSTREAM_PERMISSION", "账号无权访问，请检查 API 开通状态、组织权限和 IP 白名单。")),
            ("kimi", "resource_not_found_error") => Some(("UPSTREAM_MODEL", "模型不存在或账号无权访问，请核对模型 ID 和账户权限。")),
            ("kimi", "exceeded_current_quota_error") => Some(("UPSTREAM_QUOTA", "余额或 Token 额度不足，请检查 Kimi 开放平台账户。")),
            ("kimi", "rate_limit_reached_error") => Some(("UPSTREAM_RATE_LIMIT", "请求达到组织限速，请稍后重试。")),
            ("kimi", "engine_overloaded_error") => Some(("UPSTREAM_OVERLOADED", "模型服务暂时过载，请稍后重试。")),
            _ => None,
        });
    let identified = identified.or_else(|| match (vendor, error["code"].as_u64()) {
        ("siliconflow", Some(20012)) => Some(("UPSTREAM_MODEL", "模型不存在，请从该服务的模型列表重新选择或核对模型 ID。")),
        ("siliconflow", Some(50505)) => Some(("UPSTREAM_OVERLOADED", "模型服务暂时过载，请稍后重试。")),
        _ => None,
    }).or_else(|| {
        if vendor != "openrouter" { return None; }
        if matches!(error["metadata"]["limit_source"].as_str(), Some("openrouter_guardrail_budget" | "openrouter_workspace_budget" | "openrouter_key_limit")) {
            return Some(("UPSTREAM_QUOTA", "密钥、工作空间或策略预算已用尽，请检查 OpenRouter 的预算设置或等待额度重置。"));
        }
        match error["metadata"]["error_type"].as_str() {
            Some("payment_required") => Some(("UPSTREAM_QUOTA", "账户或密钥可用额度不足，请检查 OpenRouter 余额和额度。")),
            Some("context_length_exceeded" | "string_too_long") => Some(("UPSTREAM_CONTEXT_LIMIT", "对话长度超过模型限制，请缩短内容或更换上下文容量更大的模型。")),
            Some("max_tokens_exceeded" | "token_limit_exceeded") => Some(("UPSTREAM_TOKEN_LIMIT", "回复达到 Token 限额而中断，请检查模型输出限制和可用额度。")),
            Some("content_policy_violation" | "refusal") => Some(("UPSTREAM_POLICY", "服务商的内容规则拒绝了本次请求，请查看所选模型的使用规则。")),
            Some("rate_limit_exceeded") => Some(("UPSTREAM_RATE_LIMIT", "请求达到服务限速，请稍后重试。")),
            Some("provider_overloaded" | "provider_unavailable") => Some(("UPSTREAM_OVERLOADED", "所选模型的上游服务暂不可用，请稍后重试或选择其他模型。")),
            _ => None,
        }
    });
    let (code, hint) = identified.unwrap_or_else(|| match status {
        401 => ("UPSTREAM_AUTHENTICATION", "密钥认证失败，请核对密钥、所属平台及服务地域。"),
        402 => ("UPSTREAM_QUOTA", "账户或密钥额度不足，请检查服务商账户和用量。"),
        403 if vendor == "gemini" => ("UPSTREAM_PERMISSION", "服务拒绝访问，请检查 AI Studio 项目的 API 权限、密钥限制和可用地域。"),
        403 if vendor == "openrouter" => ("UPSTREAM_PERMISSION", "服务拒绝访问，请检查模型权限、预算以及账号或服务商的内容规则。"),
        403 => ("UPSTREAM_PERMISSION", "服务拒绝访问，请核对模型所属通道、账户权限、地域或使用限制。"),
        404 => ("UPSTREAM_NOT_FOUND", "API 地址或模型不存在，也可能未对账号开放，请核对地址和模型 ID。"),
        405 => ("UPSTREAM_PROTOCOL", "地址不支持当前请求，请填写 OpenAI 兼容的 Chat Completions API 地址。"),
        408 | 504 => ("UPSTREAM_TIMEOUT", "服务响应超时，请稍后重试。"),
        413 => ("UPSTREAM_REQUEST_SIZE", "请求内容过大，请减少对话或图片内容。"),
        429 => ("UPSTREAM_RATE_LIMIT", "请求速率或使用配额受限，请检查用量并稍后重试。"),
        400 | 422 => ("UPSTREAM_PARAMETERS", "请求被拒绝，请核对模型、请求参数以及密钥与服务地址是否匹配。"),
        300..400 => ("UPSTREAM_REDIRECT", "API 地址发生重定向，请填写服务商提供的最终 API 地址。"),
        _ => ("UPSTREAM_STATUS", "上游服务暂不可用，请稍后重试或检查服务商状态。"),
    });
    let label = match vendor {
        "deepseek" => "DeepSeek 返回", "openai" => "OpenAI 返回", "gemini" => "Gemini 返回",
        "qwen" => "百炼返回", "kimi" => "Kimi 返回", "openrouter" => "OpenRouter 返回",
        "siliconflow" => "硅基流动返回", "opencode" => "OpenCode 返回", _ => context,
    };
    Error::new(
        if (400..500).contains(&status) {
            status
        } else {
            503
        },
        code,
        format!("{label} {status}：{hint}"),
    )
}
fn network_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        timeout()
    } else {
        unavailable()
    }
}
fn unavailable() -> Error {
    Error::stream("UPSTREAM_UNAVAILABLE", "聊天上游暂不可用")
}
fn timeout() -> Error {
    Error::stream("UPSTREAM_TIMEOUT", "聊天上游请求超时")
}
fn forbidden() -> Error {
    Error::new(
        403,
        "PRIVATE_UPSTREAM_FORBIDDEN",
        "远程自配 API 只能访问公网 HTTPS 地址；本机服务需由站主托管",
    )
}

pub(super) fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let value = u32::from(ip);
            ![
                (0x00000000, 8),
                (0x0a000000, 8),
                (0x64400000, 10),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0000000, 24),
                (0xc0000200, 24),
                (0xc0a80000, 16),
                (0xc6120000, 15),
                (0xc6336400, 24),
                (0xcb007100, 24),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ]
            .iter()
            .any(|(base, prefix)| value >> (32 - prefix) == base >> (32 - prefix))
        }
        IpAddr::V6(ip) => {
            let value = u128::from(ip);
            let global = u128::from(Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0));
            value >> 125 == global >> 125
                && ![
                    (0x2001, 0, 23),
                    (0x2001, 0xdb8, 32),
                    (0x2002, 0, 16),
                    (0x3fff, 0, 20),
                ]
                .iter()
                .any(|(a, b, prefix)| {
                    let base = u128::from(Ipv6Addr::new(*a, *b, 0, 0, 0, 0, 0, 0));
                    value >> (128 - prefix) == base >> (128 - prefix)
                })
        }
    }
}
async fn public_address(target: &Url) -> Result<SocketAddr> {
    if target.scheme() != "https" {
        return Err(forbidden());
    }
    let host = target
        .host_str()
        .ok_or_else(forbidden)?
        .trim_matches(['[', ']']);
    let port = target.port_or_known_default().ok_or_else(forbidden)?;
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| unavailable())?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(forbidden());
    }
    Ok(addresses[0])
}

fn no_proxy(host: &str, value: &str) -> bool {
    if ["localhost", "127.0.0.1", "::1", "[::1]"].contains(&host) {
        return true;
    }
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|entry| {
            if entry == "*" {
                return true;
            }
            let mut item = entry.to_lowercase();
            if item.contains("://") {
                item = Url::parse(&item)
                    .ok()
                    .and_then(|v| v.host_str().map(str::to_owned))
                    .unwrap_or_default();
            }
            item = item
                .trim_start_matches("*.")
                .trim_start_matches('.')
                .to_owned();
            if !item.contains(']')
                && let Some((without, _)) = item.rsplit_once(':')
            {
                item = without.to_owned();
            }
            !item.is_empty()
                && (host.eq_ignore_ascii_case(&item)
                    || host.to_lowercase().ends_with(&format!(".{item}")))
        })
}
fn proxy(target: &Url) -> Option<Url> {
    let bypass = env::var("NO_PROXY")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| env::var("no_proxy").ok())
        .unwrap_or_default();
    if no_proxy(target.host_str().unwrap_or(""), &bypass) {
        return None;
    }
    let keys = if target.scheme() == "https" {
        ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
    } else {
        ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
    };
    let raw = keys
        .iter()
        .find_map(|key| env::var(key).ok().filter(|v| !v.is_empty()))?;
    let raw = raw.trim();
    let mut url = Url::parse(&if raw.contains("://") {
        raw.into()
    } else {
        format!("http://{raw}")
    })
    .ok()?;
    if url.scheme() != "http" || url.host_str().is_none() {
        return None;
    }
    if url.port().is_none() {
        url.set_port(Some(8080)).ok()?;
    }
    Some(url)
}
