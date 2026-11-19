use super::*;
use crate::{
    chat::{ChannelReply, ChannelTool},
    images::remote::muse::companion,
};
use std::collections::VecDeque;

#[derive(Deserialize, Serialize, Default)]
struct Record {
    seen: VecDeque<String>,
    history: Vec<Value>,
    batch: Option<Batch>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Batch {
    id: String,
    #[serde(default)]
    requested_by: Option<String>,
    pub message_id: String,
    pub received_at: u64,
    pub notified: bool,
    pub delivered: usize,
}

pub(super) struct Conversation {
    file: PathBuf,
    session: String,
    record: Record,
}

pub(super) struct Context<'a> {
    pub app: &'a AppState,
    pub storage: &'a Storage,
    pub principal: &'a str,
    pub character: &'a str,
    pub drawing: bool,
    pub group_member: Option<&'a str>,
    pub cancel: &'a CancellationToken,
}

pub(super) enum Reply {
    Text(String),
    Results(Value),
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
        let record = read(&file).await?.unwrap_or_default();
        Ok(Self {
            file,
            session,
            record,
        })
    }

    pub fn batch(&self) -> Option<&Batch> {
        self.record.batch.as_ref()
    }

    pub async fn remember_delivery(&mut self, count: usize, notified: bool) -> Result<()> {
        if let Some(batch) = &mut self.record.batch {
            batch.delivered += count;
            batch.notified |= notified;
            self.save().await?;
        }
        Ok(())
    }

    pub async fn receive(
        &mut self,
        ctx: &Context<'_>,
        id: &str,
        received_at: u64,
        text: &str,
    ) -> Result<Option<Reply>> {
        if self.record.seen.iter().any(|seen| seen == id) {
            return Ok(None);
        }
        self.record.seen.push_back(id.into());
        if self.record.seen.len() > 200 {
            self.record.seen.pop_front();
        }
        self.save().await?;
        let text = text.trim();
        let output = match text {
            "/帮助" | "/help" if ctx.group_member.is_some() => Reply::Text("在群里 @ 我就能聊天。机主开启 Muse 后，直接 @ 我提问就由 Muse 回复，也可以保留 /muse 前缀。@ 我发 /取图 可查看本群的绘图进度和收图，发起者可以发 /开始绘图 或 /取消。".into()),
            "/帮助" | "/help" => Reply::Text("直接发文字就能聊天。开启手机绘图后，可以说「用宁宁画一张雨夜街景」。/取图 查看进度和未回传的成图，/开始绘图 开始已预览的批次，/取消 停止上次绘图。".into()),
            "/取图" | "/开始绘图" | "/取消" => self.batch_action(ctx, id, received_at, text).await?,
            _ => {
                let line: String = text.chars().take(1200).collect();
                let line = if let Some(member) = ctx.group_member {
                    let speaker = crate::storage::json_fingerprint(&json!([self.session, member]));
                    format!("群友 {}：{line}", &speaker[..10])
                } else {
                    line
                };
                let answer = self.respond(ctx, id, received_at, &line).await?;
                self.record.history.push(json!({"role":"user","content":line}));
                self.record.history.push(json!({"role":"assistant","content":answer}));
                let excess = self.record.history.len().saturating_sub(12);
                self.record.history.drain(..excess);
                self.save().await?;
                Reply::Text(answer)
            }
        };
        Ok(Some(output))
    }

    pub async fn current_batch(&self, ctx: &Context<'_>) -> Result<Value> {
        self.load_batch(ctx, &Method::GET).await
    }

    fn can_control_batch(&self, ctx: &Context<'_>) -> bool {
        ctx.group_member.is_none()
            || self.batch().and_then(|batch| batch.requested_by.as_deref()) == ctx.group_member
    }

    async fn batch_action(
        &mut self,
        ctx: &Context<'_>,
        id: &str,
        received_at: u64,
        command: &str,
    ) -> Result<Reply> {
        if self.batch().is_none() {
            return Ok(Reply::Text("这个手机会话还没有绘图批次。".into()));
        }
        let method = match command {
            "/取消" => Method::DELETE,
            "/开始绘图" if ctx.drawing => Method::PATCH,
            _ => Method::GET,
        };
        if method != Method::GET && !self.can_control_batch(ctx) {
            return Ok(Reply::Text("请让发起这批绘图的群成员来操作。".into()));
        }
        let value = self.load_batch(ctx, &method).await?;
        if method == Method::PATCH
            && value["state"] == "running"
            && let Some(batch) = &mut self.record.batch
        {
            batch.message_id = id.into();
            batch.received_at = received_at;
            batch.notified = false;
            self.save().await?;
        }
        if command == "/取图" {
            return Ok(Reply::Results(value));
        }
        Ok(Reply::Text(batch_message(&value)))
    }

    async fn load_batch(&self, ctx: &Context<'_>, method: &Method) -> Result<Value> {
        let Some(batch) = self.batch() else {
            return Ok(Value::Null);
        };
        self.draw(ctx, method, &batch.id, &[]).await
    }

    async fn save(&self) -> Result<()> {
        write(&self.file, &self.record).await
    }

    async fn respond(
        &mut self,
        ctx: &Context<'_>,
        id: &str,
        received_at: u64,
        text: &str,
    ) -> Result<String> {
        let chat = ctx
            .app
            .chat
            .as_ref()
            .ok_or_else(|| ApiError::invalid("聊天服务还没准备好"))?;
        let mut messages = self.record.history.clone();
        messages.push(json!({"role":"user","content":text}));
        for _ in 0..4 {
            let ChannelReply { text, tools } = chat
                .channel_turn(
                    ctx.app,
                    ctx.character,
                    &self.session,
                    &messages,
                    ctx.drawing,
                    ctx.group_member.is_some(),
                    ctx.cancel,
                )
                .await?;
            if tools.is_empty() {
                let answer: String = text.trim().chars().take(1600).collect();
                if answer.is_empty() {
                    return Err(ApiError::invalid("聊天模型没有返回文字"));
                }
                return Ok(answer);
            }
            if !ctx.drawing {
                return Ok("请先在绘遇的手机聊天设置里开启绘图。".into());
            }
            messages.push(assistant_call(&text, &tools));
            for tool in tools {
                let arguments: Value = serde_json::from_str(&tool.arguments).unwrap_or(Value::Null);
                let result = match tool.name.as_str() {
                    "generate_drawing_batch" => self.plan(ctx, id, received_at, arguments).await?,
                    "search_drawing_catalog" => catalog(ctx.app, &arguments)
                        .await
                        .unwrap_or_else(|_| json!({"error":"本机素材查询暂不可用"})),
                    _ => json!({"error":"手机聊天只提供素材查询和绘图"}),
                };
                if tool.name == "generate_drawing_batch" {
                    return Ok(result
                        .as_str()
                        .unwrap_or("批次已受理。发送 /取图 查看进度。")
                        .to_owned());
                }
                let content: String = result.to_string().chars().take(14_000).collect();
                messages.push(json!({"role":"tool","tool_call_id":tool.id,"content":content}));
            }
        }
        Ok("我还没找到合适的素材。可以换个关键词，或者直接描述想画的画面。".into())
    }

    async fn plan(
        &mut self,
        ctx: &Context<'_>,
        id: &str,
        received_at: u64,
        mut args: Value,
    ) -> Result<Value> {
        match args["action"].as_str() {
            Some("cancel") => {
                if !self.can_control_batch(ctx) {
                    return Ok(json!("请让发起这批绘图的群成员来取消。"));
                }
                return Ok(json!(batch_message(
                    &self.load_batch(ctx, &Method::DELETE).await?
                )));
            }
            Some("resume") => {
                return Ok(json!(format!(
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
                return Ok(json!(format!(
                    "{} 可以先发送 /取图 或 /取消。",
                    batch_message(&status)
                )));
            }
        }
        let input = args
            .as_object_mut()
            .ok_or_else(|| ApiError::invalid("本机绘图参数无效"))?;
        let preview = input.remove("action").as_ref().and_then(Value::as_str) == Some("preview");
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
            notified: false,
            delivered: 0,
        });
        self.save().await?;
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
        Ok(json!(batch_message(&result)))
    }

    async fn draw(
        &self,
        ctx: &Context<'_>,
        method: &Method,
        id: &str,
        bytes: &[u8],
    ) -> Result<Value> {
        if ctx.cancel.is_cancelled() || !is_current(ctx.app, ctx.storage) {
            return Err(ApiError::invalid("工作区已切换"));
        }
        let _admission = ctx.app.host.admit_owned()?;
        companion::batch_for(ctx.app, ctx.storage, ctx.principal, method, id, bytes).await
    }
}

pub(super) fn batch_message(batch: &Value) -> String {
    match batch["state"].as_str() {
        Some("draft") => format!(
            "出图方案已准备，共 {} 张。发 /开始绘图 确认，或发 /取消。",
            batch["jobs"].as_array().map_or(0, Vec::len)
        ),
        Some("running") => {
            let jobs = batch["jobs"].as_array();
            let done = jobs
                .into_iter()
                .flatten()
                .filter(|job| {
                    matches!(
                        job["status"].as_str(),
                        Some("succeeded" | "failed" | "cancelled")
                    )
                })
                .count();
            format!(
                "本机出图已处理 {done}/{} 张。发 /取图 查进度，或发 /取消。",
                jobs.map_or(0, Vec::len)
            )
        }
        Some("cancelling") => "正在停止这批图片。".into(),
        Some("cancelled") => "这批出图已停止。已完成的图可以发 /取图 收取。".into(),
        Some("paused") => "本机绘图暂停。发 /开始绘图 继续。".into(),
        Some("succeeded" | "failed") => "这批绘图已处理。发 /取图 收取成图。".into(),
        _ => "还没有查到这个批次的回执。".into(),
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
            if let Some(text) = args[key].as_str().filter(|text| text.len() <= 240) {
                query.append_pair(key, text);
            }
        }
        if let Some(page) = args["page"].as_u64() {
            query.append_pair("page", &page.to_string());
        }
        query.append_pair("pageSize", "8");
        query.finish()
    };
    let uri = format!("/catalog?{query}")
        .parse()
        .map_err(|_| ApiError::invalid("素材搜索参数无效"))?;
    companion::catalog(app, &uri).await
}
