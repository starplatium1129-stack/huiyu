use super::*;
use crate::images::remote::muse::companion;

impl Conversation {
    pub async fn current_batch(&self, ctx: &Context<'_>) -> Result<Value> {
        self.load_batch(ctx, &Method::GET).await
    }

    pub(super) fn can_control_batch(&self, ctx: &Context<'_>) -> bool {
        ctx.group_member.is_none()
            || self.batch().and_then(|batch| batch.requested_by.as_deref()) == ctx.group_member
    }

    pub(super) async fn batch_action(
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
            batch.reply_omitted = false;
            batch.notified = false;
            self.save().await?;
        }
        if command == "/取图" {
            return Ok(Reply::Results(value));
        }
        Ok(Reply::Text(batch_message(&value)))
    }

    pub(super) async fn load_batch(&self, ctx: &Context<'_>, method: &Method) -> Result<Value> {
        let Some(batch) = self.batch() else {
            return Ok(Value::Null);
        };
        self.draw(ctx, method, &batch.id, &[]).await
    }

    pub(super) async fn draw(
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
        companion::batch_for_channel(ctx.app, ctx.storage, ctx.principal, method, id, bytes).await
    }
}

pub(in crate::companion_channels) fn batch_message(batch: &Value) -> String {
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
