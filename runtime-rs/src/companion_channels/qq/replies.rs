use super::*;

pub(super) async fn reply(
    ctx: &Context<'_>,
    api: &Api,
    active: &mut Conversation,
    messages: &[Message],
) {
    let mut incoming: Vec<Incoming<'_>> = Vec::new();
    for message in messages {
        if !active.has_seen(&message.id) && !incoming.iter().any(|prev| prev.id == message.id) {
            incoming.push(Incoming {
                id: &message.id,
                received_at: message.received_at,
                text: &message.text,
                quoted: message.quoted.as_deref(),
            });
        }
    }
    let (Some(first), Some(message)) = (messages.first(), incoming.last()) else {
        return;
    };
    let target = first.destination();
    let tag = message_tag(message.id);
    let command = is_command(message.text);
    let available = target
        .scope
        .reply_window_ms()
        .saturating_sub(crate::host::now_ms().saturating_sub(message.received_at));
    if available < 10_000 {
        return;
    }
    let action = tokio::time::timeout(
        Duration::from_millis(available - 8000),
        active.receive(ctx, &incoming),
    )
    .await;
    if ctx.cancel.is_cancelled() || !is_current(ctx.app, ctx.storage) {
        return;
    }
    match action {
        Ok(Ok(Some(Reply::Text(text)))) => match api.text(target, message.id, &text).await {
            Ok(()) if !command => {
                let _ = active.remember_reply(&text).await;
            }
            Err(error) => eprintln!("QQ 文字发送失败：{} msg={tag}", error.code),
            Ok(()) => {}
        },
        Ok(Ok(Some(Reply::Voice {
            caption,
            spoken,
            audio,
        }))) => {
            let sending = std::time::Instant::now();
            let result = match api
                .upload_media(target, MediaKind::Audio, "huiyu.mp3", &audio)
                .await
            {
                Ok(media) => {
                    api.send(
                        target,
                        message.id,
                        1,
                        json!({"msg_type":7,"media":{"file_info":media}}),
                    )
                    .await
                }
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => {
                    eprintln!(
                        "QQ 语音已送达：scope={} msg={tag} reply_ms={} send_ms={}",
                        target.scope.conversation_channel(),
                        crate::host::now_ms().saturating_sub(message.received_at),
                        sending.elapsed().as_millis(),
                    );
                    let caption = match caption {
                        Some(text) => Some(text),
                        None => active.voice_caption(ctx, &spoken).await,
                    };
                    if let Some(caption) = caption.as_ref()
                        && let Err(error) = api
                            .send(
                                target,
                                message.id,
                                2,
                                json!({"msg_type":0,"content":caption}),
                            )
                            .await
                    {
                        eprintln!("QQ 语音中文对照发送失败：{}", error.code);
                    }
                    if !command {
                        let _ = active
                            .remember_reply(caption.as_deref().unwrap_or(&spoken))
                            .await;
                    }
                }
                Err(error) => {
                    eprintln!("QQ 语音发送失败：{} msg={tag}", error.code);
                    if error.submission_not_accepted {
                        let caption = match caption {
                            Some(text) => Some(text),
                            None => active.voice_caption(ctx, &spoken).await,
                        };
                        let text = format!(
                            "刚才那段语音没发成。我先打字给你。\n{}",
                            caption.as_deref().unwrap_or(&spoken)
                        );
                        if api.text(target, message.id, &text).await.is_ok() && !command {
                            let _ = active.remember_reply(&text).await;
                        }
                    }
                }
            }
        }
        Ok(Ok(Some(Reply::Results(batch)))) => {
            if let Err(error) = deliver(ctx, api, active, target, message.id, &batch, false).await {
                eprintln!("QQ 手动取图发送失败：{} msg={tag}", error.code);
            }
        }
        Ok(Ok(None)) => {}
        Ok(Err(error)) => {
            eprintln!("QQ 对话未完成：{} msg={tag}", error.code);
            let text = if command && message.text.starts_with("/语音") {
                "这段语音没发成，晚一点再试吧。"
            } else if command {
                "刚才那张图我没处理好，晚点再试一下吧。"
            } else {
                match error.code.as_str() {
                    "UPSTREAM_TIMEOUT" | "CHAT_TIMEOUT" => "让你等久了，刚才那句没回上。",
                    "CHATGPT_USAGE_LIMIT" | "CHATGPT_RATE_LIMIT" => "我得缓一会儿，晚点聊吧。",
                    _ => "刚刚卡了一下，漏回了你一句。",
                }
            };
            if let Err(error) = api.text(target, message.id, text).await {
                eprintln!("QQ 故障提示发送失败：{} msg={tag}", error.code);
            }
        }
        Err(_) => {
            eprintln!("QQ 回复处理超时：msg={tag}");
            let _ = api
                .text(target, message.id, "让你等久了，这次没弄好。")
                .await;
        }
    }
}

pub(super) async fn notify(
    ctx: &Context<'_>,
    api: &Api,
    active: &mut Conversation,
    target: Destination<'_>,
    settings: &Settings,
) {
    let Some(ticket) = active.batch().filter(|batch| !batch.notified).cloned() else {
        return;
    };
    if crate::host::now_ms().saturating_sub(ticket.received_at)
        > target.scope.reply_window_ms().saturating_sub(15_000)
    {
        let _ = active.remember_delivery(0, true).await;
        return;
    }
    let Ok(batch) = active.current_batch(ctx).await else {
        return;
    };
    if matches!(
        batch["state"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    ) {
        let turn = Context {
            group_member: ticket
                .requested_by
                .as_deref()
                .or_else(|| (target.scope == QqScope::Group).then_some("")),
            is_owner: target.scope == QqScope::Private
                || settings.groups.iter().any(|group| {
                    group.id == target.id
                        && ticket.requested_by.is_some()
                        && group.owner_member_id == ticket.requested_by
                }),
            ..*ctx
        };
        if let Err(error) =
            deliver(&turn, api, active, target, &ticket.message_id, &batch, true).await
        {
            eprintln!(
                "QQ 自动收图发送失败：{} msg={}",
                error.code,
                message_tag(&ticket.message_id)
            );
        }
    }
}

async fn deliver(
    ctx: &Context<'_>,
    api: &Api,
    active: &mut Conversation,
    target: Destination<'_>,
    message_id: &str,
    batch: &Value,
    automatic: bool,
) -> Result<()> {
    if !is_current(ctx.app, ctx.storage) {
        return Ok(());
    }
    if matches!(
        batch["state"].as_str(),
        Some("running" | "cancelling" | "paused" | "draft")
    ) || batch.is_null()
    {
        return api.text(target, message_id, &batch_message(batch)).await;
    }
    let images = batch["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|job| job["status"] == "succeeded")
        .filter_map(|job| job["imageId"].as_str())
        .collect::<Vec<_>>();
    let departed = active.batch().map_or(0, |value| value.delivered);
    let remaining = images.len().saturating_sub(departed);
    let image_seq = if automatic && active.batch().is_some_and(|batch| batch.reply_omitted) {
        1
    } else {
        2
    };
    let out_of_memory = batch["jobs"].as_array().is_some_and(|jobs| {
        jobs.iter()
            .any(|job| job["status"] == "failed" && job["error"] == "NATIVE_OUT_OF_MEMORY")
    });
    if !automatic {
        let notice = if remaining > 3 {
            format!("还有 {remaining} 张可领取，这次发 3 张。再发 /取图 继续领取。")
        } else if remaining == 0 && !images.is_empty() {
            "这批成图已全部回传，可在绘遇作品册查看。".into()
        } else if remaining == 0 {
            if out_of_memory {
                "这批绘图显存不足。可以让我按模型默认尺寸再画一次。".into()
            } else {
                "这批绘图已结束，没有可回传的成图。".into()
            }
        } else {
            format!("这批有 {remaining} 张成图，现在发给你。")
        };
        api.text(target, message_id, &notice).await?;
    } else {
        // Keep any acknowledgement and pictures in separate reply slots.
        // A new /取图 command can recover any receipt that QQ never confirmed.
        active.remember_delivery(0, true).await?;
        if remaining == 0 {
            let issue = if out_of_memory {
                DeliveryIssue::DrawingMemory
            } else if batch["state"] == "cancelled" {
                DeliveryIssue::DrawingStopped
            } else {
                DeliveryIssue::Drawing
            };
            let text = active.delivery_reply(ctx, issue).await;
            api.send(
                target,
                message_id,
                image_seq,
                json!({"msg_type":0,"content":text}),
            )
            .await?;
            return active.remember_reply(&text).await;
        }
    }
    for (index, alias) in images.into_iter().skip(departed).take(3).enumerate() {
        if !is_current(ctx.app, ctx.storage) {
            return Ok(());
        }
        let sending = Instant::now();
        let (name, bytes) = media::read_image(ctx.storage, alias, ctx.cancel).await?;
        let media = api
            .upload_media(target, MediaKind::Image, name, &bytes)
            .await?;
        api.send(
            target,
            message_id,
            image_seq + index as u8,
            json!({"msg_type":7,"media":{"file_info":media}}),
        )
        .await?;
        eprintln!(
            "QQ 图片已送达：msg={} send_ms={}",
            message_tag(message_id),
            sending.elapsed().as_millis()
        );
        active.remember_delivery(1, false).await?;
    }
    Ok(())
}
