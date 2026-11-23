use super::*;

impl Conversation {
    pub(super) async fn voice_command(&self, ctx: &Context<'_>, content: &str) -> Result<Reply> {
        if !ctx.voice {
            return Ok(Reply::Text("这会儿发不了语音，我们先用文字聊吧。".into()));
        }
        let spoken = if !content.is_empty() {
            content.to_owned()
        } else if let Some(last) = self
            .record
            .history
            .iter()
            .rev()
            .find(|item| item["role"] == "assistant")
            .and_then(|item| item["content"].as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            last.to_owned()
        } else {
            return Ok(Reply::Text(
                "还没有可以朗读的上一条回复，可以直接发送「/语音 要说的话」。".into(),
            ));
        };
        Ok(
            match synthesize_voice(ctx, &spoken, ChannelSpeech::default()).await {
                Ok(audio) => self.voice_reply(ctx, spoken, audio).await,
                Err(error) => Reply::Text(voice_fallback(&spoken, &error)),
            },
        )
    }

    pub(super) async fn voice_reply(
        &self,
        ctx: &Context<'_>,
        spoken: String,
        audio: Bytes,
    ) -> Reply {
        let caption = if self.qq {
            None
        } else {
            self.voice_caption(ctx, &spoken).await
        };
        Reply::Voice {
            caption,
            spoken,
            audio,
        }
    }

    pub(in crate::companion_channels) async fn voice_caption(
        &self,
        ctx: &Context<'_>,
        spoken: &str,
    ) -> Option<String> {
        let line: String = spoken.trim().chars().take(500).collect();
        if !line.chars().any(crate::voice::is_kana) {
            return Some(line);
        }
        let chat = ctx.app.chat.as_ref()?;
        let message = [json!({"role":"user","content":line})];
        let reply = tokio::time::timeout(
            Duration::from_secs(15),
            chat.channel_turn(
                ctx.app,
                ctx.character,
                &self.session,
                &message,
                ChannelTurnOptions {
                    caption_only: true,
                    provider: ctx.chat_provider,
                    ..Default::default()
                },
                ctx.cancel,
            ),
        )
        .await
        .ok()?
        .ok()?;
        let caption = reply.text.trim();
        (!caption.is_empty()).then(|| caption.chars().take(500).collect())
    }
}

pub(super) fn voice_fallback(spoken: &str, error: &ApiError) -> String {
    eprintln!("QQ 语音合成失败：{}", error.code);
    format!("{}\n{spoken}", DeliveryIssue::Voice.fallback())
}

pub(super) async fn synthesize_voice(
    ctx: &Context<'_>,
    text: &str,
    options: ChannelSpeech<'_>,
) -> Result<Bytes> {
    let voice = ctx
        .app
        .voice
        .as_ref()
        .ok_or_else(|| ApiError::new(409, "VOICE_DISABLED", "语音服务未启用"))?;
    voice
        .synthesize_channel_mp3(ctx.app, text, ctx.voice_profile, options, ctx.cancel)
        .await
}
