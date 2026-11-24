use super::*;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReplyBody {
    pub(super) request_key: String,
    text: Option<String>,
    mention_sender_id: Option<String>,
    image: Option<attachment::EncodedFile>,
    audio: Option<attachment::EncodedFile>,
    #[serde(default)]
    skip: bool,
}

pub(super) async fn submit_reply(
    app: &AppState,
    mailbox: &Mailbox,
    body: ReplyBody,
) -> Result<Json<Value>> {
    let entry = mailbox.entry(&body.request_key)?;
    let settings = mailbox.settings(app).await?;
    if !settings.muse_for(entry.scope, entry.destination().id) || !allows(&settings, entry.destination()) {
        return Err(expired());
    }
    if entry.expires_at <= crate::host::now_ms() {
        let delivery = entry.delivery.lock().await;
        if !mailbox.cancel.is_cancelled()
            && settings.muse_proactive
            && !delivery.skipped
            && !entry.send_attempted.load(Ordering::Relaxed)
        {
            entry.trace("expired_before_send");
            return Err(ApiError::new(
                410,
                "QQ_MUSE_REPLY_NOT_SENT",
                "回复已过期，原消息未向 QQ 投递",
            ));
        }
        return Err(expired());
    }
    entry.trace("reply_received");
    if body.skip {
        if body.text.is_some()
            || body.mention_sender_id.is_some()
            || body.image.is_some()
            || body.audio.is_some()
        {
            return Err(ApiError::invalid("跳过时只提交 requestKey 和 skip"));
        }
        let mut delivery = entry.delivery.lock().await;
        reply_window(app, mailbox, &entry)?;
        if delivery.text.is_some() || delivery.media.is_some() {
            return Err(ApiError::new(409, "QQ_MUSE_CONFLICT", "此消息已经开始回复"));
        }
        delivery.skipped = true;
        entry.trace("skipped");
        return Ok(Json(
            json!({"ok":true,"requestKey":entry.key,"status":"skipped"}),
        ));
    }
    let text = body.text.as_deref().map(str::trim);
    if text.is_some_and(|s| s.is_empty() || s.chars().count() > 1600)
        || text.is_none() && body.image.is_none() && body.audio.is_none()
    {
        return Err(ApiError::invalid(
            "请提供语音、图片或 1 到 1600 字的回复文字",
        ));
    }
    if body.mention_sender_id.is_some() && (entry.scope != QqScope::Group || text.is_none()) {
        return Err(ApiError::invalid("群聊 @ 成员时请同时提交回复文字"));
    }
    let media = match (body.image, body.audio) {
        (Some(_), Some(_)) => return Err(ApiError::invalid("一次回复只能附带一张图片或一段语音")),
        (Some(image), None) => Some(image.decode(MediaKind::Image)?),
        (None, Some(audio)) => Some(audio.decode(MediaKind::Audio)?),
        (None, None) => None,
    };
    if text.is_none() && media.is_some() {
        entry.delivery.lock().await.needs_media = true;
    }
    if media.is_none() && body.mention_sender_id.is_none() && text == Some(attachment::NENE_COMMAND)
    {
        attachment::send_nene(app, mailbox, &entry, attachment::Selection::Exact).await?;
    } else {
        if let Some(text) = text {
            send_answer(
                app,
                mailbox,
                &entry,
                TextAnswer {
                    text: text.to_owned(),
                    mention_sender_id: body.mention_sender_id,
                },
                media.is_some(),
            )
            .await?;
        }
        if let Some(file) = media {
            attachment::send(app, mailbox, &entry, file, attachment::Selection::Exact).await?;
        } else if entry.attach_nene {
            attachment::send_nene(app, mailbox, &entry, attachment::Selection::IfMissing).await?;
        }
    }
    Ok(Json(
        json!({"ok":true,"requestKey":entry.key,"status":"sent"}),
    ))
}

pub(super) fn expired() -> ApiError {
    ApiError::new(
        410,
        "QQ_MUSE_EXPIRED",
        "消息已过期或绑定已更新，请群友重新提问",
    )
}

pub(super) fn reply_window(app: &AppState, mailbox: &Mailbox, entry: &Entry) -> Result<Duration> {
    let remaining = entry.expires_at.saturating_sub(crate::host::now_ms());
    if remaining == 0
        || mailbox.cancel.is_cancelled()
        || !app
            .host
            .storage()
            .is_some_and(|s| s.runtime_epoch() == mailbox.epoch)
    {
        return Err(expired());
    }
    Ok(Duration::from_millis(remaining))
}

async fn send_answer(
    app: &AppState,
    mailbox: &Mailbox,
    entry: &Entry,
    answer: TextAnswer,
    needs_media: bool,
) -> Result<()> {
    let mut delivery = entry.delivery.lock().await;
    let remaining = reply_window(app, mailbox, entry)?;
    if delivery.skipped {
        return Err(ApiError::new(409, "QQ_MUSE_SKIPPED", "此消息已经跳过"));
    }
    if delivery
        .text
        .as_ref()
        .is_some_and(|previous| previous.answer != answer)
    {
        return Err(ApiError::new(
            409,
            "QQ_MUSE_CONFLICT",
            "此消息已有另一条回复，重试请沿用原文和 @ 对象",
        ));
    }
    let retry = delivery.text.is_some();
    if !retry {
        let message = mailbox.text_message(
            entry.scope,
            &entry.conversation_id,
            &answer.text,
            answer.mention_sender_id.as_deref(),
        )?;
        delivery.text = Some(TextDelivery { answer, message });
    }
    delivery.needs_media |= needs_media;
    if !delivery.confirmed {
        let message = delivery.text.as_ref().unwrap().message.clone();
        entry.send_attempted.store(true, Ordering::Relaxed);
        // Keep sequence 2 for compatibility with earlier gateways and replays.
        let send = mailbox
            .api
            .send(entry.destination(), &entry.message_id, 2, message);
        let result = tokio::select! {
            biased;
            _ = mailbox.cancel.cancelled() => return Err(expired()),
            result = tokio::time::timeout(remaining, send) => result.map_err(|_| expired())?,
        };
        if let Err(error) = result
            && !(retry && error.code == "QQ_MESSAGE_DUPLICATE")
        {
            if error.submission_not_accepted || error.code == "QQ_MESSAGE_DUPLICATE" {
                delivery.text = None;
            }
            return Err(error);
        }
        delivery.confirmed = true;
        let text = delivery.text.as_ref().map(|text| text.answer.text.as_str());
        entry.trace("qq_text_confirmed");
        mailbox
            .remember_sent(entry.scope, &entry.conversation_id, "text", text)
            .await;
    }
    Ok(())
}
