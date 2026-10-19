use crate::{
    AppState,
    byte_buffer::Buffer,
    error::{ApiError, Result},
    security,
};
use axum::{
    Extension, Json, Router,
    body::{Body, Bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, State},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use url::Url;

const MAX_AUDIO_BYTES: usize = 44 + 16_000 * 2 * 30;
const MAX_REPLY_BYTES: usize = 256 * 1024;
const RECOGNITION_TIMEOUT: Duration = Duration::from_secs(120);

struct Service {
    client: reqwest::Client,
    slots: Arc<Semaphore>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    endpoint: String,
    model: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    language: String,
}

pub fn router() -> Router<AppState> {
    let service = Arc::new(Service {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .timeout(RECOGNITION_TIMEOUT)
            .build()
            .expect("Initialize speech input HTTP client"),
        slots: Arc::new(Semaphore::new(2)),
    });
    Router::new()
        .route(
            "/api/speech-input/transcribe",
            post(transcribe).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/speech-input/probe",
            post(probe).layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .layer(Extension(service))
}

fn local(headers: &HeaderMap, peer: SocketAddr) -> Result<()> {
    if !security::is_direct_local(headers, peer.ip()) {
        return Err(ApiError::new(
            403,
            "LOCAL_ONLY",
            "语音识别服务配置仅限本机使用",
        ));
    }
    Ok(())
}

impl Settings {
    fn target(&self, probe: bool) -> Result<Url> {
        let mut url = Url::parse(self.endpoint.trim())
            .map_err(|_| ApiError::invalid("请填写有效的语音服务 HTTP(S) 地址"))?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || self.endpoint.len() > 500
            || self.model.trim().is_empty()
            || self.model.len() > 200
            || self.api_key.len() > 1000
            || self.api_key.chars().any(char::is_control)
            || self.language.len() > 20
        {
            return Err(ApiError::invalid(
                "请检查语音服务地址、模型和密钥；地址不能包含用户信息、查询参数或片段",
            ));
        }
        let path = url.path().trim_end_matches('/');
        let base = path.strip_suffix("/audio/transcriptions").unwrap_or(path);
        let path = format!(
            "{base}/{}",
            if probe {
                "models"
            } else {
                "audio/transcriptions"
            }
        );
        url.set_path(&path);
        Ok(url)
    }
}

async fn transcribe(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut form: Multipart,
) -> Result<Response> {
    local(&headers, peer)?;
    let mut values = HashMap::new();
    let mut audio = None;
    while let Some(field) = form
        .next_field()
        .await
        .map_err(|_| ApiError::invalid("录音上传不完整"))?
    {
        let name = field.name().unwrap_or("").to_owned();
        if name == "file" && audio.is_none() {
            let bytes = field
                .bytes()
                .await
                .map_err(|_| ApiError::invalid("录音上传不完整"))?;
            validate_wav(&bytes)?;
            audio = Some(bytes);
        } else if ["endpoint", "model", "apiKey", "language"].contains(&name.as_str())
            && !values.contains_key(&name)
        {
            let text = field
                .text()
                .await
                .map_err(|_| ApiError::invalid("语音配置无效"))?;
            if text.len() > 1000 {
                return Err(ApiError::invalid("语音配置超过长度限制"));
            }
            values.insert(name, text);
        } else {
            return Err(ApiError::invalid("录音请求包含未知或重复字段"));
        }
    }
    let settings = Settings {
        endpoint: values.remove("endpoint").unwrap_or_default(),
        model: values.remove("model").unwrap_or_default(),
        api_key: values.remove("apiKey").unwrap_or_default(),
        language: values.remove("language").unwrap_or_default(),
    };
    let target = settings.target(false)?;
    let audio = audio.ok_or_else(|| ApiError::invalid("缺少录音文件"))?;
    let slot =
        service.slots.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(429, "SPEECH_BUSY", "语音识别正在处理其他录音，请稍后重试")
        })?;
    let cancel = state.shutdown.child_token();
    // The response body owns the upstream future: closing/aborting the client
    // drops recognition, its socket and its admission slot without a detached task.
    let body = futures_util::stream::once(async move {
        let _slot = slot;
        let result = tokio::select! {
            _ = cancel.cancelled() => Err(ApiError::new(503, "SPEECH_CANCELED", "语音识别已取消")),
            result = tokio::time::timeout(RECOGNITION_TIMEOUT, recognize(&service.client, target, settings, audio)) =>
                result.unwrap_or_else(|_| Err(timeout())),
        };
        let value = match result {
            Ok(text) => {
                let mut value = json!({"ok":true,"text":null});
                value["text"] = text.into();
                value
            }
            Err(error) => {
                let mut value = json!({"ok":false,"error":null,"code":null});
                value["error"] = error.message.into();
                value["code"] = error.code.into();
                value
            }
        };
        Ok::<_, std::convert::Infallible>(Bytes::from(value.to_string()))
    });
    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        Body::from_stream(body),
    )
        .into_response())
}

fn validate_wav(bytes: &[u8]) -> Result<()> {
    if bytes.len() <= 44
        || bytes.len() > MAX_AUDIO_BYTES
        || (bytes.len() - 44) % 2 != 0
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || &bytes[12..16] != b"fmt "
        || bytes[16..20] != 16u32.to_le_bytes()
        || bytes[20..22] != 1u16.to_le_bytes()
        || bytes[22..24] != 1u16.to_le_bytes()
        || bytes[24..28] != 16_000u32.to_le_bytes()
        || bytes[32..34] != 2u16.to_le_bytes()
        || bytes[34..36] != 16u16.to_le_bytes()
        || &bytes[36..40] != b"data"
        || bytes[40..44] != ((bytes.len() - 44) as u32).to_le_bytes()
        || bytes[4..8] != ((bytes.len() - 8) as u32).to_le_bytes()
    {
        return Err(ApiError::invalid(
            "录音需为最长 30 秒的 16kHz 单声道 PCM16 WAV",
        ));
    }
    Ok(())
}

async fn recognize(
    client: &reqwest::Client,
    target: Url,
    settings: Settings,
    audio: Bytes,
) -> Result<String> {
    let part = reqwest::multipart::Part::stream(audio)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|_| ApiError::invalid("录音格式无效"))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", settings.model.trim().to_owned())
        .text("response_format", "json");
    if !settings.language.trim().is_empty() {
        form = form.text("language", settings.language.trim().to_owned());
    }
    let mut request = client
        .post(target)
        .multipart(form)
        .header("accept", "application/json");
    if !settings.api_key.is_empty() {
        request = request.bearer_auth(settings.api_key);
    }
    let response = request.send().await.map_err(network)?;
    let status = response.status();
    let bytes = read_reply(response).await?;
    if !status.is_success() {
        return Err(provider_status(status.as_u16()));
    }
    let mut value: Value = serde_json::from_slice(bytes.as_ref()).map_err(|_| {
        ApiError::new(
            502,
            "SPEECH_PAYLOAD",
            "语音服务返回了无法解析的内容，请检查转写接口",
        )
    })?;
    let Some(Value::String(mut text)) = value.get_mut("text").map(Value::take) else {
        return Err(ApiError::new(
            502,
            "SPEECH_PAYLOAD",
            "语音服务未返回 text 字段，请检查转写接口",
        ));
    };
    let leading = text.len() - text.trim_start().len();
    if leading > 0 {
        drop(text.drain(..leading));
    }
    text.truncate(text.trim_end().len());
    Ok(text)
}

async fn probe(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(settings): Json<Settings>,
) -> Result<Json<Value>> {
    local(&headers, peer)?;
    let target = settings.target(true)?;
    let mut request = service.client.get(target).timeout(Duration::from_secs(10));
    if !settings.api_key.is_empty() {
        request = request.bearer_auth(&settings.api_key);
    }
    let operation = async {
        let response = request.send().await.map_err(network)?;
        let status = response.status();
        let bytes = read_reply(response).await?;
        if matches!(status.as_u16(), 404 | 405) {
            return Ok(Json(
                json!({"ok":true,"state":"unknown","message":"服务已响应，但未提供模型列表；转写能力需实际录音确认。"}),
            ));
        }
        if !status.is_success() {
            return Err(provider_status(status.as_u16()));
        }
        let value: Value = serde_json::from_slice(bytes.as_ref()).map_err(|_| {
            ApiError::new(
                502,
                "SPEECH_PAYLOAD",
                "模型列表响应无效；转写能力需实际录音确认",
            )
        })?;
        let models = value.get("data").and_then(Value::as_array);
        let matched = models.is_some_and(|items| {
            items
                .iter()
                .any(|v| v.get("id").and_then(Value::as_str) == Some(settings.model.trim()))
        });
        let (status, message) = if matched {
            ("ok", "服务已连接，模型已列出；转写能力需实际录音确认。")
        } else {
            (
                "unknown",
                "服务已连接，但未确认所填识别模型；请核对模型名，再实际录音。",
            )
        };
        Ok(Json(json!({"ok":true,"state":status,"message":message})))
    };
    tokio::select! {
        _ = state.shutdown.cancelled() => Err(ApiError::new(503, "SPEECH_CANCELED", "语音服务已停止")),
        result = tokio::time::timeout(Duration::from_secs(10), operation) => result.unwrap_or_else(|_| Err(timeout())),
    }
}

async fn read_reply(response: reqwest::Response) -> Result<Buffer> {
    let mut stream = response.bytes_stream();
    let mut bytes = Buffer::Chunk(Bytes::new());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network)?;
        if bytes.as_ref().len().saturating_add(chunk.len()) > MAX_REPLY_BYTES {
            return Err(ApiError::new(
                502,
                "SPEECH_PAYLOAD",
                "语音服务响应超过大小限制",
            ));
        }
        bytes.append(chunk, 0);
    }
    Ok(bytes)
}

fn provider_status(status: u16) -> ApiError {
    let message = match status {
        401 | 403 => "语音服务拒绝授权，请检查 API Key 和访问权限",
        404 => "未找到语音转写接口，请检查服务地址是否包含正确的 /v1 前缀",
        429 => "语音服务请求过多或额度不足，请稍后重试",
        _ => "语音服务请求失败，请检查识别模型和服务状态",
    };
    ApiError::new(
        502,
        "SPEECH_UPSTREAM",
        format!("{message}（HTTP {status}）"),
    )
}
fn network(error: reqwest::Error) -> ApiError {
    if error.is_timeout() {
        timeout()
    } else {
        ApiError::new(
            502,
            "SPEECH_UNAVAILABLE",
            "无法连接语音识别服务，请检查地址和服务是否启动",
        )
    }
}
fn timeout() -> ApiError {
    ApiError::new(504, "SPEECH_TIMEOUT", "语音识别服务请求超时，请稍后重试")
}
