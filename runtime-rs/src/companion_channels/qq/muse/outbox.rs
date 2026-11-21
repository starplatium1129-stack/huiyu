use super::*;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const RECEIPT_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const UPLOAD_LEASE_MS: i64 = 2 * 60 * 1000;
const RECEIPT_LIMIT: i64 = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendBody {
    request_key: String,
    conversation_id: String,
    text: Option<String>,
    mention_sender_id: Option<String>,
    image: Option<attachment::EncodedFile>,
    audio: Option<attachment::EncodedFile>,
}

enum Payload {
    Text(String),
    Media(attachment::Attachment),
}

async fn target(app: &AppState, mailbox: &Mailbox, id: &str) -> Result<Target> {
    let settings = mailbox.settings(app).await?;
    if !settings.muse_proactive {
        return Err(ApiError::new(
            403,
            "QQ_MUSE_PROACTIVE_DISABLED",
            "请先在绘遇的 QQ 设置中允许 Muse 主动发送",
        ));
    }
    mailbox
        .targets(&settings)
        .into_iter()
        .find(|item| item.conversation_id == id)
        .ok_or_else(|| ApiError::new(403, "QQ_MUSE_TARGET", "此会话未授权给 Muse"))
}

pub(super) async fn send(app: &AppState, mailbox: &Mailbox, body: SendBody) -> Result<Json<Value>> {
    let key = Uuid::parse_str(&body.request_key)
        .map_err(|_| ApiError::invalid("主动发送需要 UUID 格式的 requestKey"))?
        .to_string();
    let id = body.conversation_id;
    let scope = target(app, mailbox, &id).await?.scope;
    let mention_sender_id = body.mention_sender_id.as_deref();
    if mention_sender_id.is_some() && (scope != QqScope::Group || body.text.is_none()) {
        return Err(ApiError::invalid("群聊 @ 成员时请同时提交文字").not_accepted());
    }
    let payload = match (body.text, body.image, body.audio) {
        (Some(text), None, None) if !text.trim().is_empty() && text.chars().nth(1600).is_none() => {
            Payload::Text(text)
        }
        (None, Some(image), None) => Payload::Media(image.decode(MediaKind::Image)?),
        (None, None, Some(audio)) => Payload::Media(audio.decode(MediaKind::Audio)?),
        _ => {
            return Err(ApiError::invalid(
                "每次请发送 1 到 1600 字的文字、一张图片或一段语音",
            ));
        }
    };
    let (kind, data) = match &payload {
        Payload::Text(text) => ("text", text.as_bytes()),
        Payload::Media(file) => (file.kind.name(), file.bytes.as_ref()),
    };
    let history_text = match &payload {
        Payload::Text(text) => Some(text.clone()),
        _ => None,
    };
    let digest = hex::encode(Sha256::digest(data));
    // Keep the original fingerprint for existing text and media receipts.
    let fingerprint = crate::storage::json_fingerprint(&match mention_sender_id {
        Some(sender_id) => json!([id, kind, digest, sender_id]),
        None => json!([id, kind, digest]),
    });
    let storage = app
        .host
        .storage()
        .filter(|s| s.runtime_epoch() == mailbox.epoch)
        .ok_or_else(expired)?;
    let principal = principal(app).ok_or_else(expired)?;
    let file = state_path(
        app,
        &storage,
        &principal,
        &json!(["qq", "muse-outbox", mailbox.api.app_id]),
    )
    .with_extension("sqlite3");
    let receipt = Receipt {
        file,
        key: key.clone(),
        fingerprint,
        attempt: Uuid::new_v4().to_string(),
    };
    let confirmed =
        Json(json!({"ok":true,"requestKey":key,"conversationId":id,"status":"sent","kind":kind}));
    let live = Mailbox::current(app)?;
    if !std::ptr::eq(mailbox, live.as_ref()) {
        return Err(expired());
    }
    if matches!(receipt.claim().await?, Claim::Sent) {
        return Ok(confirmed);
    }

    // Uploads use srv_send_msg=false. They can safely be retried until we begin a message POST.
    let prepared = async {
        let message = match payload {
            Payload::Text(text) => mailbox.text_message(scope, &id, &text, mention_sender_id)?,
            Payload::Media(file) => {
                let bound = target(app, mailbox, &id).await?;
                let destination = Destination {
                    scope: bound.scope,
                    id: &bound.id,
                };
                let file_info = tokio::select! {
                    biased;
                    _ = mailbox.cancel.cancelled() => return Err(expired()),
                    result = file.upload(mailbox, destination) => result?,
                };
                json!({"msg_type":7,"media":{"file_info":file_info}})
            }
        };
        Ok((message, app.host.admit_owned()?))
    }
    .await;
    let (message, admission) = match prepared {
        Ok(value) => value,
        Err(error) => {
            receipt.transition("preparing", "retry").await?;
            return Err(error);
        }
    };
    let app = app.clone();
    // Once a message POST is possible, keep processing its acknowledgement if the HTTP caller leaves.
    tokio::spawn(async move {
        let _admission = admission;
        receipt.transition("preparing", "sending").await?;
        let result = async {
            let bound = target(&app, &live, &id).await.map_err(ApiError::not_accepted)?;
            if live.cancel.is_cancelled() {
                return Err(expired().not_accepted());
            }
            let destination = Destination { scope: bound.scope, id: &bound.id };
            tokio::select! {
                biased;
                _ = live.cancel.cancelled() => Err(uncertain()),
                result = tokio::time::timeout(Duration::from_secs(75), live.api.proactive(destination, message)) => {
                    result.map_err(|_| uncertain())?
                }
            }
        }.await;
        match result {
            Ok(()) => {
                receipt.transition("sending", "sent").await.map_err(|_| uncertain())?;
                live.remember_sent(scope, &id, kind, history_text.as_deref()).await;
                eprintln!("Muse 主动发送已获 QQ 确认");
                Ok(())
            }
            Err(error) if error.submission_not_accepted => {
                receipt.transition("sending", "retry").await?;
                Err(error)
            }
            Err(_) => Err(uncertain()),
        }
    }).await.map_err(|_| uncertain())??;
    Ok(confirmed)
}

fn uncertain() -> ApiError {
    ApiError::new(
        409,
        "QQ_MUSE_SEND_UNCERTAIN",
        "发送已开始，尚未取得可复用的 QQ 回执。请用原编号和原内容再查，勿换编号重发",
    )
}

enum Claim {
    Prepare,
    Sent,
}

#[derive(Clone)]
struct Receipt {
    file: PathBuf,
    key: String,
    fingerprint: String,
    attempt: String,
}

impl Receipt {
    async fn db<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection, &Receipt) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let receipt = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut db = Connection::open(&receipt.file)?;
            db.busy_timeout(Duration::from_secs(3))?;
            db.execute_batch("PRAGMA synchronous=FULL")?;
            work(&mut db, &receipt)
        })
        .await
        .map_err(|_| ApiError::new(503, "QQ_MUSE_RECEIPTS", "主动发送收据暂不可用"))?
    }

    async fn claim(&self) -> Result<Claim> {
        self.db(|db, receipt| {
            db.execute_batch("CREATE TABLE IF NOT EXISTS deliveries (
                request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, attempt TEXT NOT NULL,
                state TEXT NOT NULL, preparing_until INTEGER NOT NULL, expires_at INTEGER NOT NULL
            ) WITHOUT ROWID")?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = crate::host::now_ms() as i64;
            tx.execute("DELETE FROM deliveries WHERE expires_at <= ?1", [now])?;
            let prior: Option<(String, String, i64)> = tx.query_row(
                "SELECT fingerprint, state, preparing_until FROM deliveries WHERE request_key = ?1",
                [&receipt.key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            ).optional()?;
            if let Some((fingerprint, state, lease)) = prior {
                if fingerprint != receipt.fingerprint {
                    return Err(ApiError::new(409, "QQ_MUSE_SEND_CONFLICT", "此编号已用于其他内容或会话"));
                }
                match state.as_str() {
                    "sent" => return Ok(Claim::Sent),
                    "preparing" if lease > now => {
                        return Err(ApiError::new(409, "QQ_MUSE_SEND_PENDING", "正在准备此次发送，请稍后沿用原编号查询"));
                    }
                    "retry" | "preparing" => {}
                    // No reliable QQ deduplication key exists for a proactive POST.
                    // A crash, cancellation, or ambiguous response leaves this row in sending.
                    _ => return Err(uncertain()),
                }
            } else {
                let count: i64 = tx.query_row("SELECT COUNT(*) FROM deliveries", [], |r| r.get(0))?;
                if count >= RECEIPT_LIMIT {
                    return Err(ApiError::new(429, "QQ_MUSE_OUTBOX_FULL", "24 小时内的主动发送收据已满，请稍后再发"));
                }
            }
            tx.execute("INSERT INTO deliveries(request_key,fingerprint,attempt,state,preparing_until,expires_at)
                VALUES (?1,?2,?3,'preparing',?4,?5)
                ON CONFLICT(request_key) DO UPDATE SET attempt=excluded.attempt, state='preparing',
                    preparing_until=excluded.preparing_until, expires_at=excluded.expires_at",
                params![receipt.key, receipt.fingerprint, receipt.attempt, now + UPLOAD_LEASE_MS, now + RECEIPT_TTL_MS])?;
            tx.commit()?;
            Ok(Claim::Prepare)
        }).await
    }

    async fn transition(&self, previous: &'static str, next: &'static str) -> Result<()> {
        self.db(move |db, receipt| {
            let changed = db.execute(
                "UPDATE deliveries SET state=?1, expires_at=?2
                 WHERE request_key=?3 AND attempt=?4 AND state=?5",
                params![
                    next,
                    crate::host::now_ms() as i64 + RECEIPT_TTL_MS,
                    receipt.key,
                    receipt.attempt,
                    previous
                ],
            )?;
            if changed == 1 {
                Ok(())
            } else {
                Err(ApiError::new(
                    409,
                    "QQ_MUSE_SEND_PENDING",
                    "该次尝试已更新，请用原编号和原内容查询",
                ))
            }
        })
        .await
    }
}
