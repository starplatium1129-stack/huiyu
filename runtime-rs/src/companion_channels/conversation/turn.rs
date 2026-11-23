use super::*;
use crate::{
    chat::{ChannelReply, ChannelTool},
    images::remote::muse::companion,
};

impl Conversation {
    pub(super) async fn respond(
        &mut self,
        ctx: &Context<'_>,
        id: &str,
        received_at: u64,
        line: &str,
    ) -> Result<RespondOutcome> {
        let chat = ctx
            .app
            .chat
            .as_ref()
            .ok_or_else(|| ApiError::invalid("聊天服务还没准备好"))?;
        let (mut messages, memories) = self.chat_context(ctx);
        if !self.qq {
            messages.push(json!({"role":"user","content":line}));
        }
        let request: String = line.chars().take(92).collect();
        let mut drawing_rejected = false;
        let mut retried_chat = false;
        for _ in 0..4 {
            let options = ChannelTurnOptions {
                drawing: ctx.drawing,
                voice: ctx.voice,
                ..ctx.chat_options(&memories)
            };
            let request_turn = || {
                chat.channel_turn(
                    ctx.app,
                    ctx.character,
                    &self.session,
                    &messages,
                    options,
                    ctx.cancel,
                )
            };
            let started = tokio::time::Instant::now();
            let result = match request_turn().await {
                Err(error)
                    if self.qq
                        && !retried_chat
                        && !ctx.cancel.is_cancelled()
                        && matches!(
                            error.code.as_str(),
                            "UPSTREAM_UNAVAILABLE" | "UPSTREAM_TIMEOUT"
                        ) =>
                {
                    retried_chat = true;
                    eprintln!("QQ 聊天请求重试：{} msg={}", error.code, message_tag(id));
                    // The model hasn't returned a tool call for this step yet.
                    tokio::time::timeout(Duration::from_secs(12), request_turn())
                        .await
                        .unwrap_or(Err(error))
                }
                result => result,
            };
            let ChannelReply { text, tools } = result?;
            if self.qq && !tools.is_empty() {
                eprintln!(
                    "QQ 聊天模型返回操作：msg={} count={} chat_ms={}",
                    message_tag(id),
                    tools.len(),
                    started.elapsed().as_millis()
                );
            }
            if tools.is_empty() {
                let answer: String = text.trim().chars().take(1600).collect();
                if answer.is_empty() {
                    return Err(ApiError::invalid("聊天模型没有返回文字"));
                }
                return Ok(RespondOutcome::Text {
                    answer,
                    can_auto_voice: !drawing_rejected,
                });
            }
            messages.push(assistant_call(&text, &tools));
            for tool in tools {
                let arguments: Value = serde_json::from_str(&tool.arguments).unwrap_or(Value::Null);
                if tool.name == "send_voice_message" {
                    if !ctx.voice {
                        return Ok(RespondOutcome::Text {
                            answer: "这会儿发不了语音，我们先用文字聊吧。".into(),
                            can_auto_voice: false,
                        });
                    }
                    let spoken: String = arguments["text"]
                        .as_str()
                        .unwrap_or("")
                        .trim()
                        .chars()
                        .take(500)
                        .collect();
                    let spoken = if spoken.is_empty() {
                        text.trim().chars().take(500).collect::<String>()
                    } else {
                        spoken
                    };
                    if spoken.is_empty() {
                        return Ok(RespondOutcome::Text {
                            answer: self.delivery_reply(ctx, DeliveryIssue::Voice).await,
                            can_auto_voice: false,
                        });
                    }
                    let options = ChannelSpeech {
                        japanese: arguments["japanese"].as_str(),
                        emotion: arguments["emotion"].as_str(),
                        reference_emotion: arguments["referenceEmotion"].as_str(),
                        consistency: arguments["consistency"].as_str(),
                        speed: arguments["speed"].as_f64(),
                    };
                    return Ok(match synthesize_voice(ctx, &spoken, options).await {
                        Ok(audio) => RespondOutcome::Voice { spoken, audio },
                        Err(error) => RespondOutcome::Text {
                            answer: voice_fallback(&spoken, &error),
                            can_auto_voice: false,
                        },
                    });
                }
                if !ctx.drawing {
                    return Ok(RespondOutcome::Text {
                        answer: "现在画不了，可以先陪你想想画面。".into(),
                        can_auto_voice: false,
                    });
                }
                let result = match tool.name.as_str() {
                    "huiyu_drawing" => {
                        let agent = if let Some(group) = &self.qq_group {
                            let member = ctx.group_member.ok_or_else(|| ApiError::invalid("共享绘图缺少群成员身份"))?;
                            qq::group_drawing_agent(group, member)
                        } else if self.qq {
                            "qq".into()
                        } else {
                            "wechat".into()
                        };
                        tokio::select! {
                            _ = ctx.cancel.cancelled() => return Ok(RespondOutcome::Silent),
                            result = crate::images::remote::agent_cli::invoke(ctx.app, &arguments, &agent, self.qq_group.is_some()) => result,
                        }
                    }
                    "generate_drawing_batch" => {
                        match self.plan(ctx, id, received_at, &request, arguments).await {
                            Ok(Some(answer)) => {
                                return Ok(RespondOutcome::Text {
                                    answer,
                                    can_auto_voice: false,
                                });
                            }
                            Ok(None) => return Ok(RespondOutcome::Silent),
                            Err(error) if error.submission_not_accepted => {
                                drawing_rejected = true;
                                Err(error)
                            }
                            Err(error) if self.qq => {
                                eprintln!("QQ 绘图提交未完成：{}", error.code);
                                return Ok(RespondOutcome::Text {
                                    answer: self.delivery_reply(ctx, DeliveryIssue::Drawing).await,
                                    can_auto_voice: false,
                                });
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    "search_drawing_catalog" => catalog(ctx.app, &arguments).await,
                    "get_drawing_catalog_item" => {
                        companion::catalog_detail(
                            ctx.app,
                            arguments["kind"].as_str().unwrap_or(""),
                            arguments["id"].as_str().unwrap_or(""),
                        )
                        .await
                    }
                    "get_drawing_options" => {
                        companion::drawing_options(
                            ctx.app,
                            arguments["modelId"].as_str(),
                            arguments["character"].as_str(),
                            ctx.cancel.child_token(),
                        )
                        .await
                    }
                    _ => Err(ApiError::invalid("手机聊天只提供素材查询、绘图和语音")),
                };
                let result = result.unwrap_or_else(|error| {
                    eprintln!("手机聊天工具 {} 未完成：{}", tool.name, error.code);
                    let message = if error.status.is_client_error()
                        || error.code == "SCENE_RECIPES_UNAVAILABLE"
                        || tool.name == "huiyu_drawing"
                    {
                        error.message.as_str()
                    } else {
                        "本机绘图服务暂时无法完成这项操作"
                    };
                    json!({"accepted":false,"code":error.code,"error":message})
                });
                let content: String = result.to_string().chars().take(14_000).collect();
                messages.push(json!({"role":"tool","tool_call_id":tool.id,"content":content}));
            }
        }
        Ok(RespondOutcome::Text {
            answer: if drawing_rejected && self.qq {
                self.delivery_reply(ctx, DeliveryIssue::Drawing).await
            } else {
                "我还没找到合适的素材。可以换个关键词，或者直接描述想画的画面。".into()
            },
            can_auto_voice: false,
        })
    }

    async fn plan(
        &mut self,
        ctx: &Context<'_>,
        id: &str,
        received_at: u64,
        request: &str,
        mut args: Value,
    ) -> Result<Option<String>> {
        match args["action"].as_str() {
            Some("cancel") => {
                if !self.can_control_batch(ctx) {
                    return Ok(Some("这张得请刚才让我画的人来取消。".into()));
                }
                return Ok(Some(batch_message(
                    &self.load_batch(ctx, &Method::DELETE).await?,
                )));
            }
            Some("resume") => {
                return Ok(Some(format!(
                    "{} 发送 /取图 收取图片。",
                    batch_message(&self.load_batch(ctx, &Method::GET).await?)
                )));
            }
            _ => {}
        }
        if self.batch().is_some() {
            let status = self.load_batch(ctx, &Method::GET).await?;
            if matches!(
                status["state"].as_str(),
                Some("running" | "cancelling" | "draft" | "paused")
            ) {
                return Ok(Some(if self.qq && status["state"] == "running" {
                    self.delivery_reply(ctx, DeliveryIssue::DrawingBusy).await
                } else if self.qq {
                    self.delivery_reply(ctx, DeliveryIssue::DrawingWaiting)
                        .await
                } else {
                    format!("{} 可以先发送 /取图 或 /取消。", batch_message(&status))
                }));
            }
        }
        let input = args
            .as_object_mut()
            .ok_or_else(|| ApiError::invalid("本机绘图参数无效").not_accepted())?;
        let preview = input.remove("action").as_ref().and_then(Value::as_str) == Some("preview");
        let photo_description = input.remove("photoDescription").and_then(|value| {
            let description: String = value.as_str()?.trim().chars().take(90).collect();
            (!description.is_empty()).then(|| format!("原定画面：{description}"))
        });
        let reply = input.remove("reply").and_then(|value| {
            let text = value.as_str()?.trim();
            (!text.is_empty()).then(|| text.chars().take(240).collect::<String>())
        });
        let reply_omitted = !preview && reply.is_none();
        input.insert("preview".into(), json!(preview));
        let key = crate::storage::json_fingerprint(&json!([self.session, id]));
        let mut bytes = [0_u8; 16];
        hex::decode_to_slice(&key[..32], &mut bytes).expect("fingerprint is hexadecimal");
        let batch_id = uuid::Uuid::from_bytes(bytes).to_string();
        // Record the stable batch identity before any submission can be accepted.
        let prior = self.record.batch.replace(Batch {
            id: batch_id.clone(),
            requested_by: ctx.group_member.map(str::to_owned),
            message_id: id.into(),
            received_at,
            reply_omitted,
            photo_description: self
                .qq
                .then(|| photo_description.unwrap_or_else(|| format!("当时对方的请求：{request}"))),
            notified: false,
            delivered: 0,
        });
        self.save().await?;
        let started = tokio::time::Instant::now();
        let result = self
            .draw(ctx, &Method::POST, &batch_id, &serde_json::to_vec(&args)?)
            .await;
        if let Err(error) = &result
            && error.submission_not_accepted
        {
            self.record.batch = prior;
            self.save().await?;
        }
        let result = result?;
        if self.qq {
            eprintln!(
                "QQ 绘图已提交：msg={} batch_ms={}",
                message_tag(id),
                started.elapsed().as_millis()
            );
        }
        if matches!(result["state"].as_str(), Some("running" | "succeeded")) {
            return Ok(reply);
        }
        if reply_omitted && let Some(batch) = &mut self.record.batch {
            batch.reply_omitted = false;
            self.save().await?;
        }
        Ok(Some(batch_message(&result)))
    }
}

fn assistant_call(text: &str, tools: &[ChannelTool]) -> Value {
    let calls = tools.iter().map(|tool| {
        let mut value = json!({"id":tool.id,"type":"function","function":{"name":tool.name,"arguments":tool.arguments}});
        if let Some(signature) = &tool.signature { value["extra_content"] = json!({"google":{"thought_signature":signature}}); }
        value
    }).collect::<Vec<_>>();
    json!({"role":"assistant","content":text,"tool_calls":calls})
}

async fn catalog(app: &AppState, args: &Value) -> Result<Value> {
    let query = {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        for key in ["kind", "search", "character", "category", "rating"] {
            if let Some(text) = args[key]
                .as_str()
                .filter(|text| text.chars().count() <= 160)
            {
                query.append_pair(key, text);
            }
        }
        if let Some(page) = args["page"].as_u64() {
            query.append_pair("page", &page.to_string());
        }
        let page_size = args["pageSize"].as_u64().unwrap_or(8).clamp(1, 20);
        query.append_pair("pageSize", &page_size.to_string());
        query.finish()
    };
    let uri = format!("/catalog?{query}")
        .parse()
        .map_err(|_| ApiError::invalid("素材搜索参数无效"))?;
    companion::catalog_channel(app, &uri).await
}
