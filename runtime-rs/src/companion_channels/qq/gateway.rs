use super::*;
use futures_util::SinkExt;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message as Frame, protocol::WebSocketConfig},
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type GatewayResult<T> = std::result::Result<T, &'static str>;

#[derive(Default)]
pub(super) struct Resume {
    session: Option<String>,
    sequence: Option<u64>,
    pub connected: bool,
}

pub(super) async fn connect(
    app: &AppState,
    storage: &Storage,
    api: &Api,
    direct: &mpsc::Sender<Message>,
    groups: &mpsc::Sender<Message>,
    resume: &mut Resume,
) -> GatewayResult<()> {
    let token = api
        .token()
        .await
        .map_err(|_| "QQ 凭据验证失败，请核对 AppID 和 AppSecret")?;
    let address = json_response(
        api.client
            .get(format!("{API}/gateway"))
            .header("authorization", format!("QQBot {token}")),
    )
    .await
    .map_err(|_| "无法获取 QQ 长连接，请检查机器人权限和网络")?;
    let address = address["url"]
        .as_str()
        .and_then(|value| url::Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "wss"
                && matches!(url.host_str(), Some("api.bot.qq.com" | "api.sgroup.qq.com"))
                && url.port().is_none_or(|port| port == 443)
                && url.username().is_empty()
                && url.password().is_none()
        })
        .ok_or("QQ 没有返回有效的长连接地址")?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(512 * 1024))
        .max_frame_size(Some(512 * 1024));
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(12),
        connect_async_with_config(address.as_str(), Some(config), false),
    )
    .await
    .map_err(|_| CONNECTION_ERROR)?
    .map_err(|_| CONNECTION_ERROR)?;
    let hello = tokio::time::timeout(Duration::from_secs(12), read(&mut socket))
        .await
        .map_err(|_| CONNECTION_ERROR)??;
    let interval = hello["d"]["heartbeat_interval"]
        .as_u64()
        .filter(|value| (1000..=180_000).contains(value))
        .filter(|_| hello["op"] == 10)
        .ok_or(CONNECTION_ERROR)?;
    let credentials = format!("QQBot {token}");
    let sign_in = match (resume.session.as_ref(), resume.sequence) {
        (Some(session), Some(sequence)) => {
            json!({"op":6,"d":{"token":credentials,"session_id":session,"seq":sequence}})
        }
        _ => json!({"op":2,"d":{"token":credentials,"intents":1_u32 << 25,"shard":[0,1]}}),
    };
    write(&mut socket, &sign_in).await?;
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + Duration::from_millis(interval),
        Duration::from_millis(interval),
    );
    let mut awaiting_ack = false;
    let authentication = tokio::time::sleep(Duration::from_secs(20));
    tokio::pin!(authentication);
    let mut ready = false;
    loop {
        tokio::select! {
            _ = &mut authentication, if !ready => {
                resume.session = None;
                resume.sequence = None;
                return Err("QQ 长连接登录超时，请检查机器人消息权限");
            }
            _ = heartbeat.tick() => {
                if awaiting_ack { return Err(CONNECTION_ERROR); }
                write(&mut socket, &json!({"op":1,"d":resume.sequence})).await?;
                awaiting_ack = true;
            }
            event = read(&mut socket) => {
                let event = event?;
                match event["op"].as_u64() {
                    Some(0) => {
                        match event["t"].as_str() {
                            Some("READY") => { resume.session = event["d"]["session_id"].as_str().map(str::to_owned); ready = true; }
                            Some("RESUMED") => ready = true,
                            _ => {}
                        }
                        if ready && !resume.connected {
                            resume.connected = true;
                            app.channels.report(storage, "online", None);
                        }
                        if let Some(message) = Message::parse(&event) {
                            // Resume from the last queued event if the bounded inbox fills.
                            let inbox = if message.scope == QqScope::Group { groups } else { direct };
                            inbox.try_send(message).map_err(|_| "QQ 消息较多，正在重新接收")?;
                        }
                        if let Some(sequence) = event["s"].as_u64() { resume.sequence = Some(sequence); }
                    }
                    Some(1) => write(&mut socket, &json!({"op":1,"d":resume.sequence})).await?,
                    Some(7) => return Ok(()),
                    Some(9) => {
                        if event["d"] != true { resume.session = None; resume.sequence = None; }
                        return Err("QQ 长连接会话已失效，正在重新登录");
                    }
                    Some(11) => awaiting_ack = false,
                    _ => {}
                }
            }
        }
    }
}

async fn write(socket: &mut Socket, json: &Value) -> GatewayResult<()> {
    tokio::time::timeout(
        Duration::from_secs(8),
        socket.send(Frame::Text(json.to_string().into())),
    )
    .await
    .map_err(|_| CONNECTION_ERROR)?
    .map_err(|_| CONNECTION_ERROR)
}

async fn read(socket: &mut Socket) -> GatewayResult<Value> {
    loop {
        match socket.next().await {
            Some(Ok(Frame::Text(text))) => {
                return serde_json::from_str(&text).map_err(|_| CONNECTION_ERROR);
            }
            Some(Ok(Frame::Close(close))) => {
                return Err(match close.map(|close| u16::from(close.code)) {
                    Some(4013 | 4014) => "QQ 机器人缺少消息权限，请检查开放平台设置",
                    Some(4914 | 4915) => "QQ 机器人当前无法连接，请检查开放平台状态",
                    _ => CONNECTION_ERROR,
                });
            }
            Some(Ok(_)) => {}
            _ => return Err(CONNECTION_ERROR),
        }
    }
}
