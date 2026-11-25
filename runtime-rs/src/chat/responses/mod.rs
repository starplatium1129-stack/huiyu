mod decoder;
mod errors;
mod request;

use super::{
    ChatService, Duration, Error, Result, request_body,
    settings::Settings,
    stream::{Prepared, Protocol},
    transport::{self, Request},
    validation::Input,
};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;
use url::Url;

pub(super) use decoder::Decoder;
pub(super) use errors::{request_id, session_ended, siwc_error, upstream_code};

const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const RESPONSES_ORIGIN: &str = "https://api.openai.com";
const TOOL_NAMESPACE: &str = "huiyu";

pub(super) struct Session {
    chat: Arc<ChatService>,
    runtime: PathBuf,
    client_id: String,
    saved_at: Option<String>,
    pub request_id: Option<String>,
    pub cancel: CancellationToken,
}

impl Session {
    pub async fn recover(&self, error: &Error) -> Result<()> {
        let Some(upstream) = &error.upstream else {
            return Ok(());
        };
        self.chat
            .chatgpt
            .handle_upstream_failure(
                &self.runtime,
                &self.client_id,
                self.saved_at.as_deref(),
                upstream_code(&upstream.body),
            )
            .await
    }
}

pub(super) async fn prepare(
    chat: &Arc<ChatService>,
    settings: &Settings,
    mut input: Input,
    client_id: Option<&str>,
    admission: Option<&request_body::Admission>,
    cancel: &CancellationToken,
) -> Result<Prepared> {
    if let Some(origin) = &input.tool_result_origin
        && origin != RESPONSES_ORIGIN
    {
        return Err(Error::new(
            409,
            "TOOL_DESTINATION_CHANGED",
            "API 接收地址已改变，工具结果未发送；请重新发起并授权",
        ));
    }

    let client = &chat.transport;
    let mut session = chat
        .chatgpt
        .ensure_access_token(client, settings, client_id, true, cancel)
        .await?;
    let model = session.model.clone();
    if model.is_empty() {
        return Err(Error::new(
            400,
            "CHATGPT_MODEL_MISSING",
            "请先在聊天设置中选择一个 ChatGPT 模型。",
        ));
    }
    if !input.model.is_empty() && input.model != model {
        return Err(Error::new(
            409,
            "CHATGPT_SELECTION_CHANGED",
            "ChatGPT 模型已切换，请确认后重新发送。",
        ));
    }

    let japanese_voice = input.japanese_voice;
    if japanese_voice {
        super::stream::japanese_voice::prompt(&mut input.messages);
    }
    let body = request_body::encode(request::payload(input, &model), admission, cancel).await?;
    let target = Url::parse(RESPONSES_URL).map_err(|_| Error::invalid("Responses 地址无效"))?;
    let mut context = Session {
        chat: Arc::clone(chat),
        runtime: settings.runtime.clone(),
        client_id: session.client_id.clone(),
        saved_at: session.saved_at.clone(),
        request_id: None,
        cancel: session.cancel.clone(),
    };
    let mut transient_retries = 0u8;
    let mut refreshed_on_401 = false;
    let response = loop {
        let attempt = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
            _ = context.cancel.cancelled() => return Err(session_ended()),
            result = client.send(target.clone(), Request {
                body: Some(body.clone()),
                key: &session.access_token,
                session_id: None,
                public_only: false,
                idle: Duration::from_secs(120),
                total: Duration::from_secs(600),
                accept: "text/event-stream, application/json",
            }) => result,
        };
        let response = match attempt {
            Ok(response) => response,
            Err(error)
                if transient_retries < 2
                    && matches!(error.code.as_str(), "UPSTREAM_UNAVAILABLE" | "UPSTREAM_TIMEOUT") =>
            {
                let delay = Duration::from_millis(if transient_retries == 0 { 600 } else { 1500 });
                transient_retries += 1;
                tokio::select! {
                    _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
                    _ = context.cancel.cancelled() => return Err(session_ended()),
                    _ = tokio::time::sleep(delay) => continue,
                }
            }
            Err(error) => return Err(error),
        };
        context.request_id = request_id(response.headers());
        if response.status().is_success() {
            break response;
        }
        let status = response.status().as_u16();
        let retry_delay = response.headers().get("retry-after").map_or(
            Some(Duration::from_millis(if transient_retries == 0 { 700 } else { 1500 })),
            |value| {
                let seconds = value.to_str().ok()?.parse::<u64>().ok()?;
                (seconds <= 5).then(|| Duration::from_secs(seconds).max(Duration::from_millis(500)))
            },
        );
        let bytes = transport::bounded(response, 64 * 1024).await?;
        let body: Value = serde_json::from_slice(bytes.as_ref()).unwrap_or_default();
        let code = upstream_code(&body);
        if status == 401
            && !refreshed_on_401
            && code != "subscription_sharing_invalid_user"
            && let Ok(next_session) = chat
                .chatgpt
                .force_refresh_access_token(
                    client,
                    settings,
                    Some(&context.client_id),
                    true,
                    cancel,
                )
                .await
        {
            refreshed_on_401 = true;
            session = next_session;
            context.saved_at = session.saved_at.clone();
            context.cancel = session.cancel.clone();
            continue;
        }
        let temporary = matches!(status, 500 | 502 | 503 | 504)
            || (status == 429 && code != "subscription_sharing_usage_limit_exceeded");
        if temporary
            && transient_retries < 2
            && let Some(delay) = retry_delay
        {
            transient_retries += 1;
            tokio::select! {
                _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
                _ = context.cancel.cancelled() => return Err(session_ended()),
                _ = tokio::time::sleep(delay) => continue,
            }
        }
        let error = siwc_error(status, body, context.request_id.as_deref());
        context.recover(&error).await?;
        return Err(error);
    };

    Ok(Prepared {
        response,
        model,
        wait_ms: 0,
        protocol: Protocol::ResponsesSse(Box::new(context)),
        permit: None,
        japanese_voice,
    })
}
