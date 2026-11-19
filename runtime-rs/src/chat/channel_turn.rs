use super::*;
use crate::error::{ApiError, Result as ApiResult};
use tokio_util::sync::CancellationToken;

pub(crate) struct ChannelTool {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub signature: Option<String>,
}

pub(crate) struct ChannelReply {
    pub text: String,
    pub tools: Vec<ChannelTool>,
}

impl ChatService {
    pub(crate) async fn channel_turn(
        &self,
        app: &AppState,
        character: &str,
        session_id: &str,
        messages: &[Value],
        drawing: bool,
        in_group: bool,
        cancel: &CancellationToken,
    ) -> ApiResult<ChannelReply> {
        let work = async {
            running(app)?;
            let settings = self.settings(app).await;
            let managed = app.control.as_ref().map(|control| control.llama_auth());
            let api = settings
                .read_host()
                .await
                .map(validation::ApiSource::Personal);
            let tools = drawing && api.is_some();
            let mut system = persona::build(character, &Value::Null, None)?;
            system.push_str(if in_group { "\n当前在 QQ 群聊里，群成员可能轮流发言，回复会被全群看到。接收的是群友主动 @ 你的消息。" } else { "\n当前在手机私聊里。" });
            system.push_str("简短自然地回复。只有用户明确要求实际作图才调用绘图工具，讨论构图和提示词时直接聊天。用户如果要取图或停止，可以发 /取图 或 /取消。若没有绘图工具，不要假装已经出图。");
            let mut context = vec![json!({"role":"system","content":system})];
            context.extend_from_slice(messages);
            let input = validation::Input {
                model: String::new(),
                session_id: session_id.into(),
                api,
                tool_result_origin: None,
                tools,
                channel_tools: true,
                web_search: false,
                reasoning: "off".into(),
                messages: context,
            };
            let prepared = if input.api.is_some() {
                compatible::prepare(
                    &self.transport,
                    settings,
                    input,
                    false,
                    managed.as_ref(),
                    None,
                    cancel,
                )
                .await?
            } else {
                self.ollama
                    .prepare(&self.transport, settings, input, None, cancel)
                    .await?
            };
            let (text, calls) = stream::collect_channel(prepared, cancel.clone()).await?;
            Ok::<_, Error>(ChannelReply {
                text,
                tools: calls
                    .into_iter()
                    .map(|call| ChannelTool {
                        id: call.id,
                        name: call.name,
                        arguments: call.arguments,
                        signature: call.thought_signature,
                    })
                    .collect(),
            })
        };
        tokio::select! {
            _ = cancel.cancelled() => Err(ApiError::new(499, "ABORT_ERR", "消息处理已停止")),
            value = tokio::time::timeout(Duration::from_secs(150), work) => value
                .unwrap_or_else(|_| Err(Error::stream("CHAT_TIMEOUT", "聊天模型回复超时")))
                .map_err(|error| ApiError::new(error.status.as_u16(), error.code, error.message)),
        }
    }
}
