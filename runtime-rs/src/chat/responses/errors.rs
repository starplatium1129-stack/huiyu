use super::super::{Error, UpstreamFailure};
use serde_json::Value;

pub(in crate::chat) fn session_ended() -> Error {
    Error::new(
        401,
        "CHATGPT_REAUTH_REQUIRED",
        "当前 ChatGPT 会话已结束，请检查账号后重试。",
    )
}

pub(in crate::chat) fn request_id(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("openai-request-id")
        .or_else(|| headers.get("x-request-id"))
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_owned)
}

fn upstream_error(body: &Value) -> &Value {
    body.get("error")
        .filter(|value| value.is_object())
        .unwrap_or(body)
}

pub(in crate::chat) fn upstream_code(body: &Value) -> &str {
    upstream_error(body)["code"].as_str().unwrap_or("")
}

pub(in crate::chat) fn siwc_error(status: u16, body: Value, request_id: Option<&str>) -> Error {
    let error = upstream_error(&body);
    let raw_code = upstream_code(&body);
    let param = error["param"].as_str().filter(|value| !value.is_empty());
    let (http_status, code, mut message) = match raw_code {
        "subscription_sharing_usage_limit_exceeded" => (
            429,
            "CHATGPT_USAGE_LIMIT",
            "ChatGPT 订阅额度已达上限，请前往 ChatGPT 用量设置查看或调整限额。".to_owned(),
        ),
        "subscription_sharing_user_not_eligible" => (
            403,
            "CHATGPT_NOT_ELIGIBLE",
            "当前 ChatGPT 账号或工作区暂不支持订阅额度共享。".to_owned(),
        ),
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => (
            503,
            "CHATGPT_USAGE_UNAVAILABLE",
            "ChatGPT 额度服务暂时不可用，凭据已保留，请稍后重试。".to_owned(),
        ),
        "subscription_sharing_unsupported_capability" => {
            let suffix = param
                .map(|p| format!("（不支持的参数或能力：{p}）"))
                .unwrap_or_default();
            (
                400,
                "CHATGPT_UNSUPPORTED_CAPABILITY",
                format!(
                    "当前请求包含 ChatGPT 订阅通道暂不支持的能力或模型{suffix}，请调整设置或切换模型。"
                ),
            )
        }
        "subscription_sharing_route_not_supported" => (
            403,
            "CHATGPT_ROUTE_UNSUPPORTED",
            "该请求路径不受 ChatGPT 订阅额度通道支持。".to_owned(),
        ),
        "subscription_sharing_invalid_user" => (
            401,
            "CHATGPT_REAUTH_REQUIRED",
            "ChatGPT 登录状态无效或已断开，请在聊天设置中重新登录。".to_owned(),
        ),
        "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => (
            403,
            "CHATGPT_SCOPE_DENIED",
            "当前授权未包含 ChatGPT 订阅额度权限，请在聊天设置中重新授权。".to_owned(),
        ),
        "context_length_exceeded" => (
            400,
            "UPSTREAM_CONTEXT_LIMIT",
            "对话长度超过模型上下文限制，请开启新分支或缩短输入。".to_owned(),
        ),
        "rate_limit_exceeded" => (
            429,
            "CHATGPT_RATE_LIMIT",
            "ChatGPT 请求过于频繁，请稍后重试。".to_owned(),
        ),
        _ => match status {
            401 => (
                401,
                "CHATGPT_REAUTH_REQUIRED",
                "ChatGPT 登录认证未通过，请检查账号或重新登录。".to_owned(),
            ),
            403 => (
                403,
                "CHATGPT_FORBIDDEN",
                "OpenAI 拒绝了本次订阅额度请求，请检查账号权限、可用地区或订阅状态。".to_owned(),
            ),
            429 => (
                429,
                "CHATGPT_RATE_LIMIT",
                "ChatGPT 请求暂时受限，请稍后重试或查看用量。".to_owned(),
            ),
            400 | 422 => (
                400,
                "CHATGPT_BAD_REQUEST",
                "ChatGPT 拒绝了本次请求参数，请核对所选模型或关闭暂不支持的功能。".to_owned(),
            ),
            200 => (
                503,
                "CHATGPT_UPSTREAM_ERROR",
                "ChatGPT 在生成回复时返回错误，请稍后重试。".to_owned(),
            ),
            _ => (
                503,
                "CHATGPT_UPSTREAM_UNAVAILABLE",
                format!("ChatGPT 推理服务暂不可用（HTTP {status}），请稍后重试。"),
            ),
        },
    };
    if let Some(req_id) = request_id {
        message.push_str(&format!("（请求 ID：{req_id}）"));
    }
    let mut error = Error::new(
        if status == 200 { http_status } else { status },
        code,
        message,
    );
    error.upstream = Some(Box::new(UpstreamFailure {
        status,
        request_id: request_id.map(str::to_owned),
        body,
    }));
    error
}
