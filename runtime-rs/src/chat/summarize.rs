use super::{
    ChatService, Error, body_error, compatible, local, request_body, responses, running, stream,
    validation,
};
use crate::AppState;
use axum::{
    Extension, Json,
    body::Bytes,
    extract::{ConnectInfo, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc, time::Duration};

pub(super) async fn summarize(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let scope = app.shutdown.child_token();
    let _guard = scope.clone().drop_guard();
    let result = async {
        local(&headers, peer)?;
        running(&app)?;
        let admission = request_body::admit(&scope).await?;
        let raw = body.map_err(body_error)?;
        let payload: Value =
            serde_json::from_slice(&raw).map_err(|_| Error::invalid("请求 JSON 格式错误"))?;
        let provider = payload["provider"].as_str().unwrap_or("");
        if provider == "muse" {
            return Err(Error::invalid(
                "Muse 通道暂不支持自动生成摘要，请切换至本地模型、自定义 API 或 ChatGPT",
            ));
        }
        let chatgpt_provider = provider == "chatgpt";
        let chatgpt_client_id = if chatgpt_provider {
            payload
                .get("chatgptClientId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
        let char_name = payload["characterName"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("角色")
            .chars()
            .take(60)
            .collect::<String>();
        let user_name = payload["userName"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("用户")
            .chars()
            .take(40)
            .collect::<String>();
        let existing_summary = payload["existingSummary"]
            .as_str()
            .map(str::trim)
            .unwrap_or("")
            .chars()
            .take(3000)
            .collect::<String>();
        let raw_messages = payload["messages"]
            .as_array()
            .filter(|list| !list.is_empty())
            .ok_or_else(|| Error::invalid("需要提供对话消息才能生成摘要"))?;
        let mut transcript = String::new();
        for item in raw_messages.iter().rev().take(60).collect::<Vec<_>>().into_iter().rev() {
            let role = match item["role"].as_str() {
                Some("user") => user_name.as_str(),
                Some("assistant") => char_name.as_str(),
                _ => continue,
            };
            let content = item["content"].as_str().unwrap_or("").trim();
            if content.is_empty() {
                continue;
            }
            let snippet = content.chars().take(1000).collect::<String>();
            if transcript.chars().count() + snippet.chars().count() > 24000 {
                break;
            }
            if !transcript.is_empty() {
                transcript.push('\n');
            }
            transcript.push_str(role);
            transcript.push_str("：");
            transcript.push_str(&snippet);
        }
        if transcript.trim().is_empty() {
            return Err(Error::invalid("没有可用的对话文本可供摘要"));
        }
        let mut user_prompt = String::new();
        if !existing_summary.is_empty() {
            user_prompt.push_str("【已有前情提要】\n");
            user_prompt.push_str(&existing_summary);
            user_prompt.push_str("\n\n");
        }
        user_prompt.push_str("【需要并入的最新对话片段】\n");
        user_prompt.push_str(&transcript);

        let api = if provider == "api" {
            Some(if payload["hostConfig"] == true {
                validation::ApiSource::Host
            } else {
                validation::ApiSource::Personal(validation::api(&payload["api"])?)
            })
        } else {
            None
        };

        let messages = vec![
            json!({
                "role": "system",
                "content": "你是严谨客观的剧情记录员。请将「已有前情提要」与「最新对话片段」合并去重，整理为 300~750 字的紧凑中文摘要，严格按以下两段输出（不要额外加开场白或总结语）：\n【主线经过】按时间顺序压缩记录关键事件、关系转折与情绪变化，去掉寒暄废话。\n【当前处境与约定】写清当下所在地点、双方状态/穿着变动、未完成的约定与待推进线索。\n要求：忠实记录所有情感、亲密或成人（R18/NSFW）剧情事实，不审查、不回避、不擅自淡化或编造未发生的细节。"
            }),
            json!({
                "role": "user",
                "content": user_prompt
            }),
        ];
        let input = validation::Input {
            model: payload["model"].as_str().unwrap_or("").to_owned(),
            session_id: uuid::Uuid::new_v4().to_string(),
            api,
            tool_result_origin: None,
            tools: false,
            channel_tools: false,
            channel_voice: false,
            japanese_voice: false,
            card_tools: false,
            web_search: false,
            reasoning: "off".into(),
            sampling: validation::SamplingOptions {
                temperature: Some(0.3),
                top_p: None,
                max_tokens: Some(1000),
                frequency_penalty: None,
                presence_penalty: None,
            },
            disable_bubble_split: true,
            matched_lore: Vec::new(),
            messages,
        };
        let settings = chat.settings(&app).await;
        let managed_auth = app.control.as_ref().map(|control| control.llama_auth());
        let prepared = if chatgpt_provider {
            responses::prepare(
                &chat,
                settings,
                input,
                chatgpt_client_id.as_deref(),
                Some(&admission),
                &scope,
            )
            .await?
        } else if input.api.is_some() {
            compatible::prepare(
                &chat.transport,
                settings,
                input,
                false,
                managed_auth.as_ref(),
                Some(&admission),
                &scope,
            )
            .await?
        } else {
            chat.ollama
                .prepare(&chat.transport, settings, input, Some(&admission), &scope)
                .await?
        };
        let summary = stream::collect_text(prepared, scope.clone()).await?;
        let trimmed = summary.trim().chars().take(2800).collect::<String>();
        Ok::<Response, Error>(Json(json!({ "ok": true, "summary": trimmed })).into_response())
    };
    tokio::select! {
        biased;
        _ = app.shutdown.cancelled() => Error::new(503, "DESKTOP_DRAINING", "桌面正在维护").into_response(),
        result = tokio::time::timeout(Duration::from_secs(120), result) => result
            .unwrap_or_else(|_| Err(Error::stream("SUMMARY_TIMEOUT", "剧情摘要生成超时，请稍后重试")))
            .unwrap_or_else(IntoResponse::into_response),
    }
}
