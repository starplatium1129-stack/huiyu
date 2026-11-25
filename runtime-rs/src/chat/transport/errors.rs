use super::Error;

// These are local messages selected by documented identifiers, never upstream prose.
pub(in crate::chat) fn upstream_error(
    status: u16,
    vendor: &str,
    error: &serde_json::Value,
    context: &str,
) -> Error {
    let identified = [error["code"].as_str(), error["type"].as_str()]
        .into_iter()
        .flatten()
        .find_map(|kind| match (vendor, kind) {
            ("opencode", "FreeTierError") => Some((
                "OPENCODE_FREE_TIER_RESTRICTED",
                "免费层限制了客户端或使用场景，请核对该模型的免费层使用要求。",
            )),
            ("opencode", "MissingSessionID") => Some((
                "OPENCODE_SESSION_REQUIRED",
                "服务未收到会话标识，请更新绘遇并确认代理保留 x-opencode-session 请求头。",
            )),
            ("qwen", "Arrearage") => Some(("UPSTREAM_QUOTA", "百炼账户欠费，请检查账户余额。")),
            ("qwen", "AccessDenied.Unpurchased") => Some((
                "UPSTREAM_PERMISSION",
                "账号尚未开通百炼服务，请到百炼控制台开通。",
            )),
            ("qwen", "Model.AccessDenied" | "Workspace.AccessDenied") => Some((
                "UPSTREAM_PERMISSION",
                "密钥没有所选模型或业务空间的权限，请核对地域和业务空间授权。",
            )),
            ("qwen", "Endpoint.AccessDenied") => Some((
                "UPSTREAM_MODEL",
                "模型端点不可访问，请检查模型是否下线及业务空间权限。",
            )),
            ("qwen", "AllocationQuota.FreeTierOnly") => Some((
                "UPSTREAM_QUOTA",
                "模型免费额度已耗尽，请到百炼控制台确认额度及用完即停设置。",
            )),
            ("qwen", "insufficient_quota" | "Throttling.AllocationQuota") => Some((
                "UPSTREAM_RATE_LIMIT",
                "请求或 Token 速率达到配额，请稍后重试或调整限流额度。",
            )),
            ("kimi", "permission_denied_error") => Some((
                "UPSTREAM_PERMISSION",
                "账号无权访问，请检查 API 开通状态、组织权限和 IP 白名单。",
            )),
            ("kimi", "resource_not_found_error") => Some((
                "UPSTREAM_MODEL",
                "模型不存在或账号无权访问，请核对模型 ID 和账户权限。",
            )),
            ("kimi", "exceeded_current_quota_error") => Some((
                "UPSTREAM_QUOTA",
                "余额或 Token 额度不足，请检查 Kimi 开放平台账户。",
            )),
            ("kimi", "rate_limit_reached_error") => {
                Some(("UPSTREAM_RATE_LIMIT", "请求达到组织限速，请稍后重试。"))
            }
            ("kimi", "engine_overloaded_error") => {
                Some(("UPSTREAM_OVERLOADED", "模型服务暂时过载，请稍后重试。"))
            }
            _ => None,
        });
    let identified = identified
        .or_else(|| match (vendor, error["code"].as_u64()) {
            ("siliconflow", Some(20012)) => Some((
                "UPSTREAM_MODEL",
                "模型不存在，请从该服务的模型列表重新选择或核对模型 ID。",
            )),
            ("siliconflow", Some(50505)) => {
                Some(("UPSTREAM_OVERLOADED", "模型服务暂时过载，请稍后重试。"))
            }
            _ => None,
        })
        .or_else(|| {
            if vendor != "openrouter" {
                return None;
            }
            if matches!(
                error["metadata"]["limit_source"].as_str(),
                Some(
                    "openrouter_guardrail_budget"
                        | "openrouter_workspace_budget"
                        | "openrouter_key_limit"
                )
            ) {
                return Some((
                    "UPSTREAM_QUOTA",
                    "密钥、工作空间或策略预算已用尽，请检查 OpenRouter 的预算设置或等待额度重置。",
                ));
            }
            match error["metadata"]["error_type"].as_str() {
                Some("payment_required") => Some((
                    "UPSTREAM_QUOTA",
                    "账户或密钥可用额度不足，请检查 OpenRouter 余额和额度。",
                )),
                Some("context_length_exceeded" | "string_too_long") => Some((
                    "UPSTREAM_CONTEXT_LIMIT",
                    "对话长度超过模型限制，请缩短内容或更换上下文容量更大的模型。",
                )),
                Some("max_tokens_exceeded" | "token_limit_exceeded") => Some((
                    "UPSTREAM_TOKEN_LIMIT",
                    "回复达到 Token 限额而中断，请检查模型输出限制和可用额度。",
                )),
                Some("content_policy_violation" | "refusal") => Some((
                    "UPSTREAM_POLICY",
                    "服务商的内容规则拒绝了本次请求，请查看所选模型的使用规则。",
                )),
                Some("rate_limit_exceeded") => {
                    Some(("UPSTREAM_RATE_LIMIT", "请求达到服务限速，请稍后重试。"))
                }
                Some("provider_overloaded" | "provider_unavailable") => Some((
                    "UPSTREAM_OVERLOADED",
                    "所选模型的上游服务暂不可用，请稍后重试或选择其他模型。",
                )),
                _ => None,
            }
        });
    let (code, hint) = identified.unwrap_or_else(|| match status {
        401 => (
            "UPSTREAM_AUTHENTICATION",
            "密钥认证失败，请核对密钥、所属平台及服务地域。",
        ),
        402 => (
            "UPSTREAM_QUOTA",
            "账户或密钥额度不足，请检查服务商账户和用量。",
        ),
        403 if vendor == "gemini" => (
            "UPSTREAM_PERMISSION",
            "服务拒绝访问，请检查 AI Studio 项目的 API 权限、密钥限制和可用地域。",
        ),
        403 if vendor == "openrouter" => (
            "UPSTREAM_PERMISSION",
            "服务拒绝访问，请检查模型权限、预算以及账号或服务商的内容规则。",
        ),
        403 => (
            "UPSTREAM_PERMISSION",
            "服务拒绝访问，请核对模型所属通道、账户权限、地域或使用限制。",
        ),
        404 => (
            "UPSTREAM_NOT_FOUND",
            "API 地址或模型不存在，也可能未对账号开放，请核对地址和模型 ID。",
        ),
        405 => (
            "UPSTREAM_PROTOCOL",
            "地址不支持当前请求，请填写 OpenAI 兼容的 Chat Completions API 地址。",
        ),
        408 | 504 => ("UPSTREAM_TIMEOUT", "服务响应超时，请稍后重试。"),
        413 => (
            "UPSTREAM_REQUEST_SIZE",
            "请求内容过大，请减少对话或图片内容。",
        ),
        429 => (
            "UPSTREAM_RATE_LIMIT",
            "请求速率或使用配额受限，请检查用量并稍后重试。",
        ),
        400 | 422 => (
            "UPSTREAM_PARAMETERS",
            "请求被拒绝，请核对模型、请求参数以及密钥与服务地址是否匹配。",
        ),
        300..400 => (
            "UPSTREAM_REDIRECT",
            "API 地址发生重定向，请填写服务商提供的最终 API 地址。",
        ),
        _ => (
            "UPSTREAM_STATUS",
            "上游服务暂不可用，请稍后重试或检查服务商状态。",
        ),
    });
    let label = match vendor {
        "deepseek" => "DeepSeek 返回",
        "openai" => "OpenAI 返回",
        "gemini" => "Gemini 返回",
        "qwen" => "百炼返回",
        "kimi" => "Kimi 返回",
        "openrouter" => "OpenRouter 返回",
        "siliconflow" => "硅基流动返回",
        "opencode" => "OpenCode 返回",
        _ => context,
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

pub(super) fn network_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        timeout()
    } else {
        unavailable()
    }
}

pub(super) fn unavailable() -> Error {
    Error::stream("UPSTREAM_UNAVAILABLE", "聊天上游暂不可用")
}

pub(super) fn timeout() -> Error {
    Error::stream("UPSTREAM_TIMEOUT", "聊天上游请求超时")
}

pub(super) fn forbidden() -> Error {
    Error::new(
        403,
        "PRIVATE_UPSTREAM_FORBIDDEN",
        "远程自配 API 只能访问公网 HTTPS 地址；本机服务需由站主托管",
    )
}
