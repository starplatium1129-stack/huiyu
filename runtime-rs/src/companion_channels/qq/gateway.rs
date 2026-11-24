use super::*;
use crate::processes::Processes;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdout, Command},
};

type GatewayResult<T> = std::result::Result<T, &'static str>;
const FRAME_LIMIT: u64 = 1024 * 1024;
const IDLE_WATCHDOG: Duration = Duration::from_secs(150);
const RECONNECT_DEADLINE: Duration = Duration::from_secs(75);
const WORKER_ERROR: &str = "QQ SDK 连接进程已退出，正在重试";
const WORKER_UNAVAILABLE: &str = "QQ SDK 运行文件缺失或无法启动";
const PIPE_WRITE_ERROR: &str = "无法向 QQ SDK 发送启动参数";
const PIPE_READ_ERROR: &str = "无法读取 QQ SDK 事件";
const PIPE_FRAME_ERROR: &str = "QQ SDK 事件格式无效";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    session_id: String,
    last_seq: Option<u64>,
}

#[derive(Default)]
pub(super) struct Resume {
    session: Option<Session>,
    bot_id: Option<String>,
    pub connected: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Event {
    Ready {
        session: Session,
        #[serde(rename = "botId")]
        bot_id: Option<String>,
    },
    Resumed,
    Heartbeat,
    Reset,
    Disconnected {
        code: u16,
    },
    Failed {
        code: u16,
    },
    Message {
        kind: String,
        sequence: Option<u64>,
        data: Value,
    },
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn connect(
    app: &AppState,
    storage: &Storage,
    bot_id: &str,
    api: &Api,
    inboxes: &Inboxes,
    resume: &mut Resume,
    processes: &Arc<Processes>,
    cancel: &CancellationToken,
) -> GatewayResult<()> {
    let (node, script) = if app.config.is_packaged() {
        let helper = app.config.app_root.join("qq-sdk");
        (helper.join("node.exe"), helper.join("sdk-worker.mjs"))
    } else {
        (
            PathBuf::from("node"),
            app.config
                .app_root
                .join("scripts/maintenance/qq-sdk-worker.mjs"),
        )
    };
    if !script.is_file() || (app.config.is_packaged() && !node.is_file()) {
        return Err(WORKER_UNAVAILABLE);
    }
    let directory = script.parent().ok_or(WORKER_UNAVAILABLE)?;
    let filename = script.file_name().ok_or(WORKER_UNAVAILABLE)?;
    let mut command = Command::new(node);
    command
        .current_dir(node_directory(directory))
        .arg(filename)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("NODE_V8_COVERAGE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let process = processes
        .spawn(&mut command)
        .map_err(|_| WORKER_UNAVAILABLE)?;
    let mut input = process.take_input().ok_or(WORKER_UNAVAILABLE)?;
    let (output, stderr) = process.take_output();
    if let Some(stderr) = stderr {
        let log_bot = bot_id.to_owned();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            let mut logged = 0usize;
            loop {
                buf.clear();
                let mut limited = (&mut reader).take(1024);
                match limited.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if logged < 64 {
                            let text = String::from_utf8_lossy(&buf);
                            let line = text.trim();
                            if !line.is_empty() {
                                eprintln!("QQ SDK（{log_bot}）：{line}");
                                logged += 1;
                            }
                        }
                    }
                }
            }
        });
    }
    let mut output = BufReader::new(output.ok_or(WORKER_UNAVAILABLE)?);
    let mut start = serde_json::to_vec(&json!({
        "appId": api.app_id,
        "appSecret": api.secret,
        "session": resume.session,
    }))
    .map_err(|_| WORKER_UNAVAILABLE)?;
    start.push(b'\n');
    let result = tokio::select! {
        _ = cancel.cancelled() => Ok(()),
        result = async {
            tokio::time::timeout(Duration::from_secs(5), async {
                input.write_all(&start).await?;
                input.flush().await
            }).await.map_err(|_| PIPE_WRITE_ERROR)?.map_err(|_| PIPE_WRITE_ERROR)?;
            follow(app, storage, bot_id, api, inboxes, resume, &mut output).await
        } => result,
    };
    if let Err(detail) = result
        && let Ok(Some(status)) = process.exit_status()
    {
        eprintln!("QQ SDK 进程退出（{bot_id}）：{detail}，{status}");
    }
    // Closing the pipe tells Node to stop the SDK. Reap it before allowing a retry.
    drop(input);
    if process.stop().await.is_err() {
        let detail = "QQ SDK 进程退出未确认，请重启绘遇后再试";
        app.channels.report(storage, bot_id, "error", Some(detail));
        cancel.cancel();
        return Err(detail);
    }
    result
}

fn node_directory(directory: &Path) -> Cow<'_, Path> {
    // Node's main-module lookup on Windows cannot resolve a verbatim cwd.
    #[cfg(windows)]
    if let Some(directory) = directory.to_str() {
        if let Some(unc) = directory.strip_prefix(r"\\?\UNC\") {
            return Cow::Owned(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(drive) = directory.strip_prefix(r"\\?\") {
            return Cow::Borrowed(Path::new(drive));
        }
    }
    Cow::Borrowed(directory)
}

async fn follow(
    app: &AppState,
    storage: &Storage,
    bot_id: &str,
    api: &Api,
    inboxes: &Inboxes,
    resume: &mut Resume,
    output: &mut BufReader<ChildStdout>,
) -> GatewayResult<()> {
    let mut startup = Some(Instant::now() + Duration::from_secs(65));
    let mut line = Vec::new();
    loop {
        line.clear();
        let mut limited = (&mut *output).take(FRAME_LIMIT);
        let read = limited.read_until(b'\n', &mut line);
        let bytes = if let Some(deadline) = startup {
            tokio::time::timeout_at(deadline, read)
                .await
                .map_err(|_| "QQ SDK 登录或重连超时，正在重连")?
        } else {
            tokio::time::timeout(IDLE_WATCHDOG, read)
                .await
                .map_err(|_| "QQ 连接心跳超时，正在自动重连")?
        }
        .map_err(|_| PIPE_READ_ERROR)?;
        if bytes == 0 {
            return Err(WORKER_ERROR);
        }
        if line.last() != Some(&b'\n') {
            return Err(PIPE_FRAME_ERROR);
        }
        match serde_json::from_slice::<Event>(&line).map_err(|_| PIPE_FRAME_ERROR)? {
            Event::Ready { session, bot_id } => {
                resume.session = Some(session);
                resume.bot_id = bot_id.filter(|id| open_id(&json!(id)).is_some());
            }
            Event::Resumed => {}
            Event::Heartbeat => continue,
            Event::Reset => {
                resume.session = None;
                continue;
            }
            Event::Disconnected { code } => {
                if std::mem::take(&mut resume.connected) {
                    eprintln!("QQ WebSocket 断开（{bot_id}，code={code}），等待自动重连");
                }
                startup = Some(Instant::now() + RECONNECT_DEADLINE);
                app.channels
                    .report(storage, bot_id, "connecting", Some(disconnect_detail(code)));
                continue;
            }
            Event::Failed { code } => return Err(disconnect_detail(code)),
            Event::Message {
                kind,
                sequence,
                data,
            } => {
                queue_message(
                    &kind,
                    &data,
                    sequence,
                    resume.bot_id.as_deref(),
                    inboxes,
                    api,
                    |kind, code| {
                        app.channels.pair_code(storage, bot_id, kind).0.as_deref() == Some(code)
                    },
                )?;
                if let Some(session) = &mut resume.session
                    && sequence > session.last_seq
                {
                    session.last_seq = sequence;
                }
                continue;
            }
        }
        startup = None;
        app.channels.report(storage, bot_id, "online", None);
        if !resume.connected {
            resume.connected = true;
            eprintln!("QQ WebSocket 已连接（{bot_id}，腾讯 SDK）");
        }
    }
}

fn disconnect_detail(code: u16) -> &'static str {
    match code {
        4004 => "QQ 登录凭据无效，请检查开放平台设置",
        4013 | 4014 => "QQ 机器人缺少消息权限，请检查开放平台设置",
        4914 | 4915 => "QQ 机器人当前无法连接，请检查开放平台状态",
        _ => CONNECTION_ERROR,
    }
}

fn queue_message(
    kind: &str,
    data: &Value,
    sequence: Option<u64>,
    bot_id: Option<&str>,
    inboxes: &Inboxes,
    api: &Api,
    can_pair: impl FnOnce(QqPairKind, &str) -> bool,
) -> GatewayResult<()> {
    let log = |stage: &str, detail: &str| {
        if kind.starts_with("GROUP_") {
            let tag = event_message_id(data)
                .map(message_tag)
                .unwrap_or_else(|| "-".into());
            let group =
                open_id(&data["group_openid"]).map(|id| api.conversation_id(QqScope::Group, id));
            let member = open_id(&data["author"]["member_openid"])
                .or_else(|| open_id(&data["author"]["id"]));
            let sender = group
                .as_deref()
                .zip(member)
                .map(|(group, member)| muse_sender_id(group, member));

            eprintln!(
                "QQ 入站 type={kind} seq={sequence:?} group={:.12} sender={:.12} msg={tag} stage={stage} detail={detail}",
                group.as_deref().unwrap_or("-"),
                sender.as_deref().unwrap_or("-")
            );
        }
    };
    let message = match Message::parse(kind, data, bot_id, inboxes, api) {
        Ok(message) => message,
        Err(reason) => {
            log("filtered", reason);
            return Ok(());
        }
    };
    if let Some((kind, code)) = message.pairing_request() {
        let already_owner = kind == QqPairKind::Friend
            && inboxes.bindings.borrow().owner.as_deref() == Some(message.target.as_str());
        if kind.scope() != message.scope || (!already_owner && !can_pair(kind, code)) {
            log("filtered", "invalid-pairing");
            return Ok(());
        }
    } else if !inboxes
        .bindings
        .borrow()
        .allows(message.destination())
    {
        log("filtered", "unbound");
        return Ok(());
    }
    if message.scope == QqScope::Group
        && !message.to_muse
        && let Some(activity) = &inboxes.ambient
    {
        activity.observe(&message);
        if message.ambient {
            log("observed", "local-group-conversation");
            return Ok(());
        }
    }
    let (inbox, mut route) = inboxes.for_message(&message);
    if route == "local-group" && !message.ambient {
        route = if message.quoted.is_some() {
            "local-group-quote"
        } else {
            "local-group-mention"
        };
    }
    // Advance the resume sequence only after a message is queued or deliberately filtered.
    match inbox.try_send(message) {
        Ok(()) => log("queued", route),
        Err(mpsc::error::TrySendError::Full(_)) => {
            log("queue-full", route);
            return Err("QQ 消息较多，正在重新接收");
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            log("queue-closed", route);
            return Err("QQ 消息处理队列已关闭");
        }
    }
    Ok(())
}
