mod drawing;
mod memory;
mod turn;
mod voice;

pub(super) use drawing::batch_message;
use voice::{synthesize_voice, voice_fallback};

use super::*;
use crate::{chat::ChannelTurnOptions, voice::ChannelSpeech};
use std::collections::VecDeque;

#[derive(Deserialize, Serialize, Default)]
struct Record {
    seen: VecDeque<String>,
    history: Vec<Value>,
    batch: Option<Batch>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    photos: Vec<memory::Photo>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Batch {
    id: String,
    #[serde(default)]
    pub requested_by: Option<String>,
    pub message_id: String,
    pub received_at: u64,
    #[serde(default)]
    pub reply_omitted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    photo_description: Option<String>,
    pub notified: bool,
    pub delivered: usize,
}

pub(super) struct Conversation {
    file: PathBuf,
    session: String,
    record: Record,
    qq: bool,
    qq_group: Option<String>,
}

pub(super) struct Context<'a> {
    pub app: &'a AppState,
    pub storage: &'a Storage,
    pub principal: &'a str,
    pub character: &'a str,
    pub chat_provider: crate::chat::ChannelProvider,
    pub is_owner: bool,
    pub owner_bond: crate::chat::ChannelOwnerBond,
    pub owner_call_name: &'a str,
    pub owner_note: &'a str,
    pub drawing: bool,
    pub voice: bool,
    pub voice_auto: bool,
    pub voice_profile: &'a str,
    pub group_member: Option<&'a str>,
    pub cancel: &'a CancellationToken,
}

pub(super) enum Reply {
    Text(String),
    Voice {
        caption: Option<String>,
        spoken: String,
        audio: Bytes,
    },
    Results(Value),
}

pub(super) struct Incoming<'a> {
    pub id: &'a str,
    pub received_at: u64,
    pub text: &'a str,
    pub quoted: Option<&'a str>,
}

pub(super) fn is_command(text: &str) -> bool {
    matches!(
        text,
        "/帮助" | "/help" | "/取图" | "/开始绘图" | "/取消" | "/语音"
    ) || text.starts_with("/语音 ")
}

#[derive(Clone, Copy)]
pub(super) enum DeliveryIssue {
    Voice,
    Drawing,
    DrawingBusy,
    DrawingWaiting,
    DrawingMemory,
    DrawingStopped,
}

impl DeliveryIssue {
    fn fallback(self) -> &'static str {
        match self {
            Self::Voice => "刚才那条语音没发成，我先打字。",
            Self::Drawing => "刚才那张图没弄好。",
            Self::DrawingBusy => "刚才那张还没弄好，这张得等一会儿。",
            Self::DrawingWaiting => "上一张还停着，这张得先等等。",
            Self::DrawingMemory => "这张图没弄出来。可以试试小一点的。",
            Self::DrawingStopped => "那张已经停了，手上还没出图。",
        }
    }
}

enum RespondOutcome {
    Text {
        answer: String,
        can_auto_voice: bool,
    },
    Voice {
        spoken: String,
        audio: Bytes,
    },
    Silent,
}

impl Conversation {
    pub async fn open(ctx: &Context<'_>, channel: &str, account: &str, peer: &str) -> Result<Self> {
        let file = state_path(
            ctx.app,
            ctx.storage,
            ctx.principal,
            &json!([channel, account, peer, ctx.character]),
        );
        let session = file.file_stem().unwrap().to_string_lossy().into_owned();
        let qq = matches!(channel, "qq" | "qq-group");
        let mut record: Record = read(&file).await?.unwrap_or_default();
        if qq
            && record.photos.is_empty()
            && let Some(batch) = record.batch.as_ref().filter(|batch| batch.delivered != 0)
        {
            memory::remember_photo(&mut record.photos, batch);
        }
        Ok(Self {
            file,
            session,
            record,
            qq,
            qq_group: (channel == "qq-group").then(|| qq::group_conversation_id(account, peer)),
        })
    }

    pub fn batch(&self) -> Option<&Batch> {
        self.record.batch.as_ref()
    }

    pub async fn remember_delivery(&mut self, count: usize, notified: bool) -> Result<()> {
        if let Some(batch) = &mut self.record.batch {
            batch.delivered += count;
            batch.notified |= notified;
            if self.qq && count != 0 {
                memory::remember_photo(&mut self.record.photos, batch);
            }
            self.save().await?;
        }
        Ok(())
    }

    pub fn has_seen(&self, id: &str) -> bool {
        self.record.seen.iter().any(|seen| seen == id)
    }

    pub fn recent_replies(&self) -> impl Iterator<Item = &str> {
        self.record.history.iter().rev().filter_map(|message| {
            (message["role"] == "assistant").then(|| message["content"].as_str()).flatten()
        }).take(16)
    }

    pub async fn receive(
        &mut self,
        ctx: &Context<'_>,
        incoming: &[Incoming<'_>],
    ) -> Result<Option<Reply>> {
        let mut accepted = Vec::new();
        for message in incoming {
            if self.has_seen(message.id) {
                continue;
            }
            self.record.seen.push_back(message.id.into());
            accepted.push(message);
        }
        let Some(latest) = accepted.last() else {
            return Ok(None);
        };
        while self.record.seen.len() > 200 {
            self.record.seen.pop_front();
        }
        let id = latest.id;
        let received_at = latest.received_at;
        let text = latest.text.trim();
        if is_command(text) || !self.qq {
            self.save().await?;
        }
        let output = match text {
            "/帮助" | "/help" if ctx.group_member.is_some() => Reply::Text(
                if ctx.voice {
                    "在群里 @ 我就能聊天。@ 我发 /语音 可朗读回复（或 /语音 要说的话），@ 我发 /取图 可查看本群绘图进度和收图，发起者可以发 /开始绘图 或 /取消。"
                } else {
                    "在群里 @ 我就能聊天。机主开启 Muse 后，直接 @ 我提问就由 Muse 回复，也可以保留 /muse 前缀。@ 我发 /取图 可查看本群的绘图进度和收图，发起者可以发 /开始绘图 或 /取消。"
                }
                .into(),
            ),
            "/帮助" | "/help" => Reply::Text(
                if ctx.voice {
                    "直接发文字就能聊天。开启语音后，可直接让我发语音，或发 /语音（可跟台词）听语音。开启手机绘图后可要求画图，/取图 查进度和收图，/开始绘图 开始已预览批次，/取消 停止绘图。"
                } else {
                    "直接发文字就能聊天。开启手机绘图后，可以说「画一张雨夜街景」。/取图 查看进度和未回传的成图，/开始绘图 开始已预览的批次，/取消 停止上次绘图。"
                }
                .into(),
            ),
            "/取图" | "/开始绘图" | "/取消" => self.batch_action(ctx, id, received_at, text).await?,
            _ if text == "/语音" || text.starts_with("/语音 ") => {
                self.voice_command(ctx, text.strip_prefix("/语音").unwrap_or("").trim())
                    .await?
            }
            _ => {
                let message_limit = if accepted.len() == 1 { 1200 } else { 2400 };
                let per_message = message_limit / accepted.len();
                let line = accepted
                    .iter()
                    .map(|message| {
                        let text: String = message.text.trim().chars().take(per_message).collect();
                        if let Some(quote) = message.quoted {
                            let quote: String = quote.chars().take(320).collect();
                            format!("（引用的群消息）{quote}\n（新消息）{text}")
                        } else {
                            text
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let line = if let Some(member) = ctx.group_member {
                    if ctx.is_owner {
                        let tag = if ctx.owner_call_name.trim().is_empty() {
                            "机主（你的主人）".to_owned()
                        } else {
                            format!("机主·{}（你的主人）", ctx.owner_call_name.trim())
                        };
                        format!("{tag}：{line}")
                    } else {
                        let speaker =
                            crate::storage::json_fingerprint(&json!([self.session, member]));
                        format!("群友 {}：{line}", &speaker[..10])
                    }
                } else {
                    line
                };
                if self.qq {
                    self.push_history("user", line.clone()).await?;
                }
                match self.respond(ctx, id, received_at, &line).await? {
                    RespondOutcome::Text {
                        answer,
                        can_auto_voice,
                    } => {
                        if !self.qq {
                            self.record.history.push(json!({"role":"user","content":line}));
                            self.remember_reply(&answer).await?;
                        }
                        if ctx.voice_auto && can_auto_voice {
                            match tokio::time::timeout(
                                Duration::from_secs(90),
                                synthesize_voice(ctx, &answer, ChannelSpeech::default()),
                            )
                            .await
                            {
                                Ok(Ok(audio)) => self.voice_reply(ctx, answer, audio).await,
                                Ok(Err(error)) => {
                                    eprintln!("QQ 自动语音跳过：{}", error.code);
                                    Reply::Text(answer)
                                }
                                Err(_) => {
                                    eprintln!("QQ 自动语音超时，已回退文字回复");
                                    Reply::Text(answer)
                                }
                            }
                        } else {
                            Reply::Text(answer)
                        }
                    }
                    RespondOutcome::Voice { spoken, audio } => {
                        self.voice_reply(ctx, spoken, audio).await
                    }
                    RespondOutcome::Silent => return Ok(None),
                }
            }
        };
        Ok(Some(output))
    }

    pub async fn remember_reply(&mut self, text: &str) -> Result<()> {
        let result = self.push_history("assistant", text.to_owned()).await;
        if let Err(error) = &result {
            eprintln!("消息对话记录保存失败：{}", error.code);
        }
        result
    }

    async fn push_history(&mut self, role: &str, text: String) -> Result<()> {
        self.record
            .history
            .push(json!({"role":role,"content":text}));
        memory::trim(&mut self.record.history, self.qq);
        self.save().await
    }

    fn chat_context(&self, ctx: &Context<'_>) -> (Vec<Value>, Vec<String>) {
        if self.qq {
            memory::context(
                &self.record.history,
                &self.record.photos,
                ctx.group_member.is_some(),
            )
        } else {
            (self.record.history.clone(), Vec::new())
        }
    }

    pub async fn delivery_reply(&self, ctx: &Context<'_>, issue: DeliveryIssue) -> String {
        let fallback = issue.fallback();
        let Some(chat) = ctx.app.chat.as_ref().filter(|_| self.qq) else {
            return fallback.into();
        };
        let (messages, memories) = self.chat_context(ctx);
        let answer = tokio::time::timeout(
            Duration::from_secs(5),
            chat.channel_turn(
                ctx.app,
                ctx.character,
                &self.session,
                &messages,
                ChannelTurnOptions {
                    delivery_issue: Some(fallback),
                    ..ctx.chat_options(&memories)
                },
                ctx.cancel,
            ),
        )
        .await;
        if let Ok(Ok(answer)) = answer {
            let text = answer.text.trim();
            if !text.is_empty() && answer.tools.is_empty() && text.chars().count() <= 100 {
                return text.to_owned();
            }
        }
        fallback.into()
    }

    async fn save(&self) -> Result<()> {
        write(&self.file, &self.record).await
    }
}

impl Context<'_> {
    fn chat_options<'a>(&'a self, memories: &'a [String]) -> ChannelTurnOptions<'a> {
        ChannelTurnOptions {
            in_group: self.group_member.is_some(),
            is_owner: self.is_owner,
            owner_bond: self.owner_bond,
            owner_call_name: self.owner_call_name,
            owner_note: self.owner_note,
            provider: self.chat_provider,
            memories,
            ..Default::default()
        }
    }
}
