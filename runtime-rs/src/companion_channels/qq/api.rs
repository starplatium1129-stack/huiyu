use super::*;

pub(in crate::companion_channels) fn group_conversation_id(account: &str, group: &str) -> String {
    crate::storage::json_fingerprint(&json!([account, group]))
}

impl Api {
    pub(super) fn conversation_id(&self, scope: QqScope, id: &str) -> String {
        // Keep existing group conversation IDs across upgrades.
        let identity = match scope {
            QqScope::Group => return group_conversation_id(&self.app_id, id),
            QqScope::Private => json!([self.app_id, "private", id]),
        };
        crate::storage::json_fingerprint(&identity)
    }

    pub(super) async fn token(&self) -> Result<String> {
        let mut cached = self.token.lock().await;
        if let Some((token, expiry)) = &*cached
            && *expiry > Instant::now()
        {
            return Ok(token.clone());
        }
        let response = json_response(
            self.client
                .post("https://bots.qq.com/app/getAppAccessToken")
                .json(&json!({"appId":self.app_id,"clientSecret":self.secret})),
        )
        .await
        .map_err(|error| {
            if error.status.as_u16() == 429 || !error.status.is_client_error() {
                error
            } else {
                ApiError::new(
                    401,
                    "QQ_CREDENTIALS",
                    format!("QQ 未能验证 AppID 或 AppSecret。{}", error.message),
                )
            }
        })?;
        let token = response["access_token"]
            .as_str()
            .filter(|token| !token.is_empty() && token.len() <= 4096)
            .ok_or_else(|| ApiError::new(502, "QQ_CREDENTIALS", "QQ 凭据回执缺少访问令牌"))?;
        let expires = response["expires_in"]
            .as_u64()
            .or_else(|| response["expires_in"].as_str()?.parse().ok())
            .unwrap_or(300);
        let expires = expires.min(10_000);
        let refresh_after = expires - (expires / 10).min(30);
        *cached = Some((
            token.into(),
            Instant::now() + Duration::from_secs(refresh_after),
        ));
        Ok(token.into())
    }

    pub(super) async fn authenticated(
        &self,
        mut request: reqwest::RequestBuilder,
    ) -> Result<Value> {
        let mut retry = request.try_clone();
        loop {
            let token = self.token().await.map_err(ApiError::not_accepted)?;
            let result =
                json_response(request.header("authorization", format!("QQBot {token}"))).await;
            if !result
                .as_ref()
                .is_err_and(|error| error.code == "QQ_TOKEN_REJECTED")
            {
                return result;
            }
            let mut cached = self.token.lock().await;
            if cached
                .as_ref()
                .is_some_and(|(current, _)| current == &token)
            {
                *cached = None;
            }
            drop(cached);
            let Some(next) = retry.take() else {
                return result;
            };
            request = next;
        }
    }

    pub(super) async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.authenticated(self.client.post(format!("{API}{path}")).json(&body))
            .await
    }

    pub(super) async fn text(&self, target: Destination<'_>, id: &str, text: &str) -> Result<()> {
        let text: String = text.chars().take(1600).collect();
        self.send(target, id, 1, json!({"msg_type":0,"content":text}))
            .await
    }

    pub(super) async fn send(
        &self,
        target: Destination<'_>,
        id: &str,
        seq: u8,
        mut body: Value,
    ) -> Result<()> {
        body["msg_id"] = json!(id);
        body["msg_seq"] = json!(seq);
        self.send_message(target, body, Some(id)).await
    }

    pub(super) async fn proactive(&self, target: Destination<'_>, mut body: Value) -> Result<()> {
        let fields = body
            .as_object_mut()
            .ok_or_else(|| ApiError::invalid("QQ 主动消息格式不正确").not_accepted())?;
        for field in ["msg_id", "msg_seq", "event_id", "is_wakeup"] {
            fields.remove(field);
        }
        self.send_message(target, body, None)
            .await
            .map_err(|mut error| {
                if !error.submission_not_accepted {
                    error.code = "QQ_DELIVERY_UNKNOWN".into();
                    error.message = format!("请先在 QQ 会话核对送达情况。{}", error.message);
                }
                error
            })
    }

    async fn send_message(
        &self,
        target: Destination<'_>,
        mut body: Value,
        reply_to: Option<&str>,
    ) -> Result<()> {
        // QQ's older rich-media handlers require a nonempty content field.
        if body["msg_type"] == 7 && body["content"].as_str().is_none_or(str::is_empty) {
            body["content"] = json!(" ");
        }
        let text = (target.scope == QqScope::Group)
            .then(|| body["content"].as_str().unwrap_or("").to_owned());
        let value = self.post(&target.path("messages"), body).await?;
        if value["id"].as_str().is_some_and(|id| !id.is_empty()) {
            if let Some(text) = text {
                self.quotes.remember(target.id, &value, &text);
                if let Some((activity, id)) = self.ambient.as_ref().zip(reply_to) {
                    activity.remember_reply(target.id, id, &text);
                }
            }
            Ok(())
        } else {
            Err(ApiError::new(
                502,
                "QQ_RECEIPT_MISSING",
                "QQ 回执缺少消息 ID",
            ))
        }
    }

    pub(super) async fn upload_media(
        &self,
        target: Destination<'_>,
        kind: MediaKind,
        name: &str,
        bytes: &[u8],
    ) -> Result<String> {
        let value = self.post(&target.path("files"), json!({
            "file_type":kind as u8,"file_name":name,"file_data":STANDARD.encode(bytes),"srv_send_msg":false,
        })).await.map_err(ApiError::not_accepted)?;
        value["file_info"]
            .as_str()
            .filter(|media| !media.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| networking().not_accepted())
    }
}

async fn json_response(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request.send().await.map_err(|error| {
        if error.is_builder() || error.is_connect() && !error.is_timeout() {
            networking().not_accepted()
        } else {
            networking()
        }
    })?;
    let status = response.status();
    let unreadable = || {
        if status.is_success() {
            ApiError::new(
                502,
                "QQ_RECEIPT_MISSING",
                format!("QQ 回执无法读取（HTTP {}）", status.as_u16()),
            )
        } else {
            rejected(status, None)
        }
    };
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| unreadable())?;
        if body.len() + chunk.len() > 64 * 1024 {
            return Err(unreadable());
        }
        body.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice::<Value>(&body);
    let code = value.as_ref().ok().and_then(|data| {
        ["err_code", "code"]
            .into_iter()
            .filter_map(|field| {
                let value = &data[field];
                value
                    .as_i64()
                    .or_else(|| value.as_str()?.parse::<i64>().ok())
            })
            .find(|code| *code != 0)
    });
    if !status.is_success() || code.is_some() {
        return Err(rejected(status, code));
    }
    value.map_err(|_| unreadable())
}

fn rejected(status: reqwest::StatusCode, code: Option<i64>) -> ApiError {
    let http = status.as_u16();
    let (local_status, name, detail) = match (http, code) {
        (500..=599 | 408, _) => (502, "QQ_NETWORK", "QQ 服务未能确认请求结果"),
        (_, Some(304023 | 304024)) => (409, "QQ_AUDIT_PENDING", "QQ 已受理消息，正在审核"),
        (401, _) | (_, Some(11241 | 11242 | 11243)) => {
            (401, "QQ_TOKEN_REJECTED", "QQ 拒绝了访问令牌")
        }
        (429, _) | (_, Some(22009 | 40034100 | 40093002)) => {
            (429, "QQ_RATE_LIMIT", "已达到 QQ 发送限额，请稍后重试")
        }
        (_, Some(304027 | 304103 | 40034005 | 40034128)) => {
            (410, "QQ_REPLY_EXPIRED", "QQ 原消息的回复时间或次数已用完")
        }
        (_, Some(40054005)) => (409, "QQ_MESSAGE_DUPLICATE", "QQ 已使用这条消息的回复序号"),
        (_, Some(304003 | 40054010)) => (
            422,
            "QQ_URL_REJECTED",
            "QQ 未允许这条链接，请检查机器人后台的消息 URL 配置",
        ),
        (_, Some(850019 | 850031 | 304080)) => (
            422,
            "QQ_MEDIA_INVALID",
            "QQ 无法使用这份媒体文件，请检查文件格式和大小",
        ),
        (_, Some(304082 | 304083 | 850026 | 850027 | 40034004 | 40093001)) => (
            502,
            "QQ_MEDIA_UNAVAILABLE",
            "QQ 未能完成媒体转存，可以稍后重试",
        ),
        (_, Some(40034101 | 40054003 | 40054004)) => (
            403,
            "QQ_TARGET_UNAVAILABLE",
            "QQ 机器人尚未加入这个群或与该用户建立好友关系",
        ),
        (_, Some(304064 | 40034105 | 40054013)) => (
            403,
            "QQ_PROACTIVE_DENIED",
            "请检查机器人的主动发送权限和会话的消息接收开关",
        ),
        (403, _) | (_, Some(11253 | 11254 | 11264 | 11265 | 40054002 | 850018)) => {
            (403, "QQ_PERMISSION_DENIED", "QQ 机器人当前没有发送权限")
        }
        (_, Some(40034006 | 304061 | 40054007 | 40054018)) => (
            422,
            "QQ_CONTENT_REJECTED",
            "QQ 拒绝了这条内容，请调整正文或缩短消息",
        ),
        (_, Some(40054016 | 50055001 | 50055002)) => {
            (503, "QQ_SEND_UNAVAILABLE", "QQ 当前无法发送，请稍后重试")
        }
        _ => (422, "QQ_REJECTED", "QQ 拒绝了这次请求"),
    };
    let reason = match code {
        Some(code) => format!("HTTP {http}，QQ {code}"),
        None => format!("HTTP {http}"),
    };
    eprintln!("QQ 请求未取得成功回执：{reason}");
    let error = ApiError::new(local_status, name, format!("{detail}（{reason}）"));
    if status.is_server_error() || http == 408 || name == "QQ_AUDIT_PENDING" {
        error
    } else {
        error.not_accepted()
    }
}

fn networking() -> ApiError {
    ApiError::new(502, "QQ_NETWORK", "QQ 消息服务暂不可用")
}
