use super::super::session::{parse_earliest_refresh, parse_scopes, token_expiry};
use super::{
    AuthMode, CallbackRuntime, DYNAMIC_CLIENT_ID, RESOURCE_URI, selection_changed, storage,
};
use crate::chat::{Duration, Error, Result, transport};
use axum::{
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use url::Url;

pub(super) async fn handle_loopback_callback(
    ctx: Arc<CallbackRuntime>,
    params: HashMap<String, String>,
) -> Response {
    if params.get("state") != Some(&ctx.expected_state) {
        return callback_html(
            StatusCode::BAD_REQUEST,
            "登录状态校验失败",
            "请继续使用绘遇打开的授权页面完成登录。",
        );
    }
    {
        let mut consumed = ctx
            .consumed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *consumed {
            return callback_html(
                StatusCode::CONFLICT,
                "此授权回执已收到",
                "请返回绘遇查看登录结果。",
            );
        }
        *consumed = true;
    }

    let (record, retry_registration) = match callback_code(&ctx, &params) {
        Ok((code, client_id)) => {
            let exchange = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => return cancelled_callback(),
                result = tokio::time::timeout(Duration::from_secs(45), exchange_code(&ctx, code, &client_id)) => {
                    result.unwrap_or_else(|_| Err(Error::new(504, "CHATGPT_CALLBACK_TIMEOUT", "交换授权令牌超时，请返回绘遇重试。")))
                }
            };
            let retry = (matches!(ctx.auth_mode, AuthMode::New | AuthMode::RetryRegistration)
                && exchange
                    .as_ref()
                    .is_err_and(|error| error.code == "CHATGPT_INVALID_GRANT"))
            .then_some(client_id);
            (exchange, retry)
        }
        Err(error) => (Err(error), None),
    };

    let service = &ctx.chat.chatgpt;
    let _guard = service.storage_lock.lock().await;
    if ctx.cancel.is_cancelled()
        || !service
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .owns(&ctx.cancel)
    {
        return cancelled_callback();
    }
    let outcome = match record {
        Ok(record) => save_registration(&ctx, record).await,
        Err(error) => Err(error),
    };
    {
        let mut flow = service
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        flow.active_cancel = None;
        flow.retry_registration = retry_registration;
        match &outcome {
            Ok(_) => flow.status = "completed",
            Err(error) => {
                flow.status = "error";
                flow.error_code = Some(error.code.clone());
                flow.error = Some(error.message.clone());
            }
        }
    }

    // Defer shutdown slightly so the HTTP response finishes flushing to the browser.
    let cancel = ctx.cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        cancel.cancel();
    });

    match outcome {
        Ok(true) => callback_html(
            StatusCode::OK,
            "已连接 ChatGPT 订阅",
            "授权成功，现在可以关闭此标签页并返回绘遇开始对话。",
        ),
        Ok(false) => callback_html(
            StatusCode::OK,
            "已登录 ChatGPT 账号",
            "尚未开启 ChatGPT 订阅额度权限。你可以关闭此标签页，并在绘遇聊天设置中开启权限或切换其他模型。",
        ),
        Err(error) => callback_html(error.status, "ChatGPT 登录未完成", &error.message),
    }
}

fn cancelled_callback() -> Response {
    callback_html(
        StatusCode::GONE,
        "登录已结束",
        "请返回绘遇重新发起 ChatGPT 登录。",
    )
}

fn callback_code<'a>(
    ctx: &CallbackRuntime,
    params: &'a HashMap<String, String>,
) -> Result<(&'a str, String)> {
    if let Some(err) = params.get("error").map(String::as_str) {
        if err == "access_denied" {
            return Err(Error::new(
                403,
                "CHATGPT_ACCESS_DENIED",
                "你已取消或拒绝 ChatGPT 授权。可以随时重新授权，或改用 API 服务。",
            ));
        }
        return Err(Error::new(
            400,
            "CHATGPT_AUTH_DENIED",
            "ChatGPT 授权未能完成，请重试。",
        ));
    }
    let code = params
        .get("code")
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::new(400, "CHATGPT_CODE_MISSING", "回调缺少授权码，请重试。"))?;

    let callback_client_id = params
        .get("client_id")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let issued_client_id = match ctx.auth_mode {
        AuthMode::New => {
            let issued = callback_client_id.ok_or_else(|| {
                Error::new(
                    400,
                    "CHATGPT_CLIENT_ID_MISSING",
                    "新注册回调未返回客户端 ID，注册未完成，请重试。",
                )
            })?;
            if issued == DYNAMIC_CLIENT_ID {
                return Err(Error::new(
                    400,
                    "CHATGPT_CLIENT_ID_INVALID",
                    "回调返回的客户端 ID 无效，请重试。",
                ));
            }
            issued.to_owned()
        }
        AuthMode::RetryRegistration | AuthMode::Reauth | AuthMode::Consent => {
            let expected = ctx.expected_client_id.as_deref().ok_or_else(|| {
                Error::new(400, "CHATGPT_CLIENT_ID_MISSING", "缺少已保存的客户端 ID。")
            })?;
            if let Some(supplied) = callback_client_id
                && supplied != expected
            {
                return Err(Error::new(
                    400,
                    "CHATGPT_CLIENT_ID_MISMATCH",
                    "回调返回的客户端 ID 与所选账号不匹配，已拒绝覆盖凭据。",
                ));
            }
            expected.to_owned()
        }
    };
    Ok((code, issued_client_id))
}

async fn exchange_code(
    ctx: &CallbackRuntime,
    code: &str,
    issued_client_id: &str,
) -> Result<storage::StoredAccount> {
    let token_url = Url::parse(&ctx.discovery.token_endpoint)
        .map_err(|_| Error::new(503, "CHATGPT_AUTH_CONFIG", "OpenAI 令牌端点无效"))?;
    let response = ctx
        .chat
        .transport
        .send_form(
            token_url,
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("code_verifier", &ctx.code_verifier),
                ("redirect_uri", &ctx.redirect_uri),
                ("client_id", issued_client_id),
                ("resource", RESOURCE_URI),
            ],
            Duration::from_secs(20),
        )
        .await?;
    let status = response.status();
    let bytes = transport::bounded(response, 128 * 1024).await?;
    let tokens: Value = serde_json::from_slice(bytes.as_ref()).unwrap_or_default();
    if !status.is_success() {
        let code_name = tokens["error"].as_str().unwrap_or("");
        if code_name == "invalid_grant" {
            return Err(Error::new(
                400,
                "CHATGPT_INVALID_GRANT",
                "授权码已失效或已被使用，请重新登录。",
            ));
        }
        return Err(Error::new(
            502,
            "CHATGPT_TOKEN_EXCHANGE_FAILED",
            "无法向 OpenAI 交换访问令牌，请检查网络或代理后重试。",
        ));
    }

    let access_token = tokens["access_token"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                502,
                "CHATGPT_TOKEN_EXCHANGE_FAILED",
                "OpenAI 令牌响应缺少访问令牌。",
            )
        })?;
    let id_token = tokens["id_token"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                502,
                "CHATGPT_ID_TOKEN_MISSING",
                "OpenAI 令牌响应缺少 ID Token。",
            )
        })?;
    let refresh_token = tokens["refresh_token"].as_str();
    let expires_at = token_expiry(&tokens);
    let earliest_refresh_at = parse_earliest_refresh(&tokens["earliest_refresh_at"]);
    let granted_scopes = parse_scopes(tokens["scope"].as_str());

    let verified = ctx
        .chat
        .chatgpt
        .jwks
        .verify_id_token(
            &ctx.chat.transport,
            id_token,
            issued_client_id,
            &ctx.expected_nonce,
        )
        .await?;

    if let Some(expected_sub) = ctx.expected_subject.as_deref()
        && verified.subject != expected_sub
    {
        return Err(Error::new(
            403,
            "CHATGPT_ACCOUNT_MISMATCH",
            "登录返回的 ChatGPT 账号与当前所选账号不一致，已保留原账号凭据。",
        ));
    }

    let mut record = storage::StoredAccount {
        client_id: issued_client_id.to_owned(),
        issuer: verified.issuer,
        subject: verified.subject,
        email: verified.email,
        email_verified: verified.email_verified,
        name: verified.name,
        ..storage::StoredAccount::default()
    };
    record.set_tokens(
        access_token,
        refresh_token,
        Some(id_token),
        expires_at,
        earliest_refresh_at,
        granted_scopes,
    )?;
    Ok(record)
}

// Called while holding the same storage lock as cancellation and account removal.
async fn save_registration(
    ctx: &CallbackRuntime,
    mut record: storage::StoredAccount,
) -> Result<bool> {
    let mut store = storage::load(&ctx.runtime).await?;
    let id = record.client_id.clone();
    let plan_enabled = record.plan_enabled();
    if let Some(existing) = store.account_mut(&id) {
        if existing.issuer != record.issuer || existing.subject != record.subject {
            return Err(Error::new(
                403,
                "CHATGPT_ACCOUNT_MISMATCH",
                "ChatGPT 注册身份不匹配，原账号凭据已保留。",
            ));
        }
        record.label = existing.label.clone();
        record.selected_model = existing.selected_model.clone();
        record.selected_model_name = existing.selected_model_name.clone();
        record.usage_paused = existing.usage_paused;
        *existing = record;
    } else {
        if matches!(ctx.auth_mode, AuthMode::Reauth | AuthMode::Consent) {
            return Err(selection_changed());
        }
        record.label = store.distinct_label(&id, record.email.as_deref(), record.name.as_deref());
        store.accounts.push(record);
    }
    store.active_client_id = Some(id.clone());
    storage::save(&ctx.runtime, &store).await?;
    ctx.chat.chatgpt.stop_account(&id);
    Ok(plan_enabled)
}

fn callback_html(status: StatusCode, title: &str, message: &str) -> Response {
    let state = if status.is_success() {
        "success"
    } else {
        "error"
    };
    let title = escape_html(title);
    let message = escape_html(message);
    let html = Html(format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{title} · 绘遇</title>
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: system-ui, sans-serif; background: #0e1014; color: #f4efe9; }}
    main {{ max-width: 420px; margin: 24px; padding: 28px; border-radius: 16px;
      background: #15181f; border: 1px solid #4b4d53; }}
    h1 {{ margin: 0 0 12px; font-size: 1.15rem; display: flex; align-items: center; gap: 10px; }}
    h1::before {{ content: ''; width: 10px; height: 10px; border-radius: 50%; flex: none; }}
    [data-state='success'] h1::before {{ background: #4ade80; }}
    [data-state='error'] h1::before {{ background: #f87171; }}
    p {{ margin: 0; line-height: 1.65; font-size: .95rem; color: #b3ada6; }}
    @media (prefers-color-scheme: light) {{
      body {{ background: #f6f3ec; color: #1b181a; }}
      main {{ background: #fdfbf7; border-color: #bfb7aa; }}
      p {{ color: #5f585b; }}
      [data-state='success'] h1::before {{ background: #18763d; }}
      [data-state='error'] h1::before {{ background: #b32f3a; }}
    }}
  </style>
</head>
<body><main data-state="{state}"><h1>{title}</h1><p>{message}</p></main></body>
</html>"#
    ));
    (
        status,
        [
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
        ],
        html,
    )
        .into_response()
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
