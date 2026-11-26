mod compatible;
mod card_library;
mod chatgpt;
pub(crate) use card_library::validate_catalog_card;
mod completion;
mod channel_turn;
pub(crate) use channel_turn::{
    ChannelOwnerBond, ChannelProvider, ChannelReply, ChannelTool, ChannelTurnOptions,
};
mod local_persona;
pub(crate) mod muse;
mod ollama;
mod persona;
mod request_body;
mod responses;
mod search;
mod settings;
mod stream;

mod transport;
mod validation;
mod vision;
pub(crate) use vision::VisionRoute;

use crate::{AppState, security};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, FromRequest, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::OnceCell;

type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
struct Error {
    status: StatusCode,
    code: String,
    message: String,
    upstream: Option<Box<UpstreamFailure>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamFailure {
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    body: Value,
}

impl Error {
    fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
            code: code.into(),
            message: message.into(),
            upstream: None,
        }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "INVALID_REQUEST", message)
    }
    fn stream(code: &str, message: &str) -> Self {
        Self::new(503, code, message)
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let mut value = json!({"ok":false,"error":null,"msg":null,"code":null,"detail":""});
        value["error"] = self.message.clone().into();
        value["msg"] = self.message.into();
        value["code"] = self.code.into();
        if let Some(upstream) = self.upstream {
            value["upstream"] = json!(upstream);
        }
        (
            self.status,
            [("cache-control", "no-store")],
            Json(value),
        )
            .into_response()
    }
}

pub struct ChatService {
    muse: muse::Connections,
    chatgpt: chatgpt::ChatGptService,
    transport: transport::Transport,
    ollama: ollama::Ollama,
    settings: OnceCell<settings::Settings>,
    search: search::WebSearch,
}
impl Default for ChatService {
    fn default() -> Self {
        Self::new()
    }
}
impl ChatService {
    pub fn new() -> Self {
        Self {
            muse: muse::Connections::default(),
            chatgpt: chatgpt::ChatGptService::default(),
            transport: transport::Transport::new(),
            ollama: ollama::Ollama::new(),
            settings: OnceCell::new(),
            search: search::WebSearch::default(),
        }
    }
    pub fn queue_status(&self) -> Value {
        self.ollama.queue_status()
    }
    async fn settings(&self, app: &AppState) -> &settings::Settings {
        self.settings
            .get_or_init(|| settings::Settings::read(&app.config))
            .await
    }
}

pub(crate) async fn chat_card_exists(app: &AppState, id: &str) -> bool {
    card_library::is_id(id) && card_library::load_card(app, id).await.is_ok()
}

pub(crate) async fn chat_card_catalog_id(app: &AppState, id: &str) -> Option<String> {
    if !card_library::is_id(id) {
        return None;
    }
    card_library::load_card(app, id)
        .await
        .ok()
        .and_then(|card| card.catalog_id().map(str::to_owned))
}

pub fn router(service: Arc<ChatService>) -> Router<AppState> {
    Router::new()
        .merge(card_library::router())
        .merge(chatgpt::router())
        .route("/api/chat-status", get(status))
        .route("/api/chat/muse/status", get(muse::status))
        .route(
            "/api/chat",
            post(chat).layer(DefaultBodyLimit::max(14 * 1024 * 1024)),
        )
        .route(
            "/api/chat/summarize",
            post(summarize).layer(DefaultBodyLimit::max(512 * 1024)),
        )
        .route(
            "/api/chat/search",
            post(search_web).layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route(
            "/api/chat-provider/test",
            post(inspect).layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route(
            "/api/chat-provider/host-config",
            get(host_config)
                .post(save_host)
                .delete(delete_host)
                .layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .layer(Extension(service))
}

async fn status(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
) -> Response {
    if let Err(error) = running(&app) {
        return error.into_response();
    }
    let data = chat
        .ollama
        .status(&chat.transport, chat.settings(&app).await)
        .await;
    let mut response = Json(data).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

async fn chat(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    let scope = app.shutdown.child_token();
    let _guard = scope.clone().drop_guard();
    let result = async {
        running(&app)?;
        let admission = request_body::admit(&scope).await?;
        running(&app)?;
        let body = Bytes::from_request(request, &app)
            .await
            .map_err(body_error)?;
        let body = request_body::parse(body, &admission, &scope).await?;
        let direct = security::is_direct_local(&headers, peer.ip());
        let character = body["character"].as_str().filter(|id| !id.is_empty()).unwrap_or("nene");
        let muse_character = if body["provider"] == "muse" {
            local(&headers, peer)?;
            Some(character.to_owned())
        } else {
            None
        };
        let chatgpt_provider = body["provider"] == "chatgpt";
        let chatgpt_client_id = if chatgpt_provider {
            local(&headers, peer)?;
            body.get("chatgptClientId")
                .map(|value| {
                    value.as_str().filter(|id| !id.is_empty()).map(str::to_owned)
                        .ok_or_else(|| Error::invalid("ChatGPT 账号标识无效"))
                })
                .transpose()?
        } else {
            None
        };
        let muse_drawing = body["museDrawing"] == true && app.tasks.is_some();
        let settings = chat.settings(&app).await;
        let imported = if card_library::is_id(character) {
            local(&headers, peer)?;
            Some(card_library::load_card(&app, character).await?)
        } else { None };
        let persona = if direct && imported.is_none() {
            local_persona::read(
                settings,
                &app.config.app_root,
                character,
                &admission,
                &scope,
            )
            .await
        } else {
            None
        };
        let japanese_voice = direct && muse_character.is_none()
            && body["japaneseVoice"] == true
            && app.voice.as_ref().is_some_and(|voice| voice.speech_requires_japanese());
        let mut input = request_body::validate(body, persona, imported, direct, &admission, &scope).await?;
        input.japanese_voice = japanese_voice;
        if let Some(character) = muse_character {
            return chat.muse.submit(character, input, muse_drawing);
        }
        if direct
            && !input.disable_bubble_split
            && let Some(Value::String(system)) = input.messages.first_mut()
                .filter(|message| message["role"] == "system")
                .and_then(|message| message.get_mut("content"))
        {
            system.push_str("\n【聊天节奏】日常闲聊按意思自然分成一到两句一条，分条时留一个空行；简短回应一条就够，别拆散同一句话，也别习惯性以“记得喝水/早点休息”或机械反问收尾。对方要求长文、代码、列表或结构化内容时按所需格式写。");
        }
        let matched_lore = std::mem::take(&mut input.matched_lore);
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
                !direct,
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
        Ok(stream::response(prepared, matched_lore, app.shutdown.clone()))
    };
    // Match the client's first-event budget across body admission/read, CPU
    // work, persona I/O, queueing, DNS and upstream headers. Streaming keeps
    // its own existing budget and no longer retains the upload admission.
    let result = tokio::select! {
        biased;
        _ = app.shutdown.cancelled() => Err(Error::new(503,"DESKTOP_DRAINING","桌面正在维护")),
        result = tokio::time::timeout(Duration::from_secs(180), result) => result
            .unwrap_or_else(|_| Err(Error::stream("CHAT_PREPARE_TIMEOUT", "聊天准备超时，请稍后重试"))),
    };
    result.unwrap_or_else(IntoResponse::into_response)
}

fn local(headers: &HeaderMap, peer: SocketAddr) -> Result<()> {
    if security::is_direct_local(headers, peer.ip()) {
        Ok(())
    } else {
        Err(Error::new(403, "LOCAL_ONLY", "此操作仅允许在本机执行"))
    }
}

async fn search_web(
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
        let body = body.map_err(body_error)?;
        let body: Value =
            serde_json::from_slice(&body).map_err(|_| Error::invalid("请求 JSON 格式错误"))?;
        Ok::<Response, Error>(
            Json(chat.search.run(&body, &scope).await?).into_response(),
        )
    };
    tokio::select! {
        _ = app.shutdown.cancelled() => Error::new(503,"DESKTOP_DRAINING","桌面正在维护").into_response(),
        result = tokio::time::timeout(Duration::from_secs(30), result) => result
            .unwrap_or_else(|_| Err(Error::stream("SEARCH_TIMEOUT", "联网检索超时，请稍后重试。")))
            .unwrap_or_else(IntoResponse::into_response),
    }
}

async fn summarize(
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

fn running(app: &AppState) -> Result<()> {
    app.host
        .check_available()
        .map_err(|error| Error::new(error.status.as_u16(), &error.code, error.message))?;
    if app.shutdown.is_cancelled() {
        return Err(Error::new(503, "DESKTOP_DRAINING", "桌面正在维护"));
    }
    Ok(())
}

fn body_error(error: axum::extract::rejection::BytesRejection) -> Error {
    Error::new(
        error.status().as_u16(),
        "INVALID_REQUEST",
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            "请求体过大"
        } else {
            "请求无法处理"
        },
    )
}

async fn inspect(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let result = async {
        local(&headers, peer)?;
        let body = body.map_err(body_error)?;
        let mut api = validation::inspect_api(
            &serde_json::from_slice(&body).map_err(|_| Error::invalid("请求 JSON 格式错误"))?,
        )?;
        running(&app)?;
        if let Some(control) = &app.control {
            let (origin, key) = control.llama_auth();
            if (api.model == "huiyu-local" || api.model.is_empty())
                && api.base_url == origin
                && api.pathname == "/v1/chat/completions"
            {
                api.key = key;
            }
        }
        let models = compatible::inspect(&chat.transport, &api)
            .await
            .map_err(|mut error| {
                if error.status.is_server_error() {
                    error.status = StatusCode::BAD_GATEWAY;
                }
                error
            })?;
        Ok::<Response, Error>(Json(models).into_response())
    };
    tokio::select! { result = result => result.unwrap_or_else(IntoResponse::into_response), _ = app.shutdown.cancelled() => Error::new(503,"DESKTOP_DRAINING","桌面正在维护").into_response() }
}

async fn host_config(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
) -> Response {
    if let Err(error) = running(&app) {
        return error.into_response();
    }
    let mut response = Json(settings::public(
        chat.settings(&app).await.read_host().await.as_ref(),
    ))
    .into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

async fn save_host(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let result = async {
        local(&headers, peer)?;
        let body = body.map_err(body_error)?;
        let _admitted = app
            .host
            .admit()
            .map_err(|error| Error::new(error.status.as_u16(), &error.code, error.message))?;
        let api = validation::api(
            &serde_json::from_slice(&body).map_err(|_| Error::invalid("请求 JSON 格式错误"))?,
        )?;
        chat.settings(&app).await.write_host(&api).await?;
        Ok::<Response, Error>(Json(settings::public(Some(&api))).into_response())
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}

async fn delete_host(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let result = async {
        local(&headers, peer)?;
        let _admitted = app
            .host
            .admit()
            .map_err(|error| Error::new(error.status.as_u16(), &error.code, error.message))?;
        chat.settings(&app).await.delete_host().await?;
        Ok::<Response, Error>(Json(settings::public(None)).into_response())
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}
