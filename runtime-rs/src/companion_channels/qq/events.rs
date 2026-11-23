use super::*;
use regex::Regex;
use std::sync::LazyLock;

static GROUP_MENTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<@!?([A-Za-z0-9_-]{1,128})>|<qqbot-at-user\s+id="([A-Za-z0-9_-]{1,128})"\s*/>"#)
        .expect("valid QQ mention pattern")
});

impl Message {
    fn muse_question(text: &str, enabled: bool) -> Option<&str> {
        let (command, question) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
        match command {
            "/帮助" | "/help" | "/取图" | "/开始绘图" | "/取消" | "/绑定" | "/绑定群" => {
                None
            }
            command if command.eq_ignore_ascii_case("/muse") => Some(question.trim()),
            _ if enabled => Some(text),
            _ => None,
        }
    }

    pub(super) fn parse(
        kind: &str,
        data: &Value,
        bot_id: Option<&str>,
        inboxes: &Inboxes,
        api: &Api,
    ) -> std::result::Result<Self, &'static str> {
        if data["author"]["bot"] == true
            || bot_id.is_some_and(|id| data["author"]["id"].as_str() == Some(id))
        {
            return Err("bot-author");
        }
        let author = &data["author"];
        let (scope, target, member) = match kind {
            "C2C_MESSAGE_CREATE" => {
                let peer = open_id(&author["user_openid"])
                    .or_else(|| open_id(&author["id"]))
                    .ok_or("invalid-sender")?;
                (QqScope::Private, peer, peer)
            }
            "GROUP_AT_MESSAGE_CREATE" | "GROUP_MESSAGE_CREATE" => (
                QqScope::Group,
                open_id(&data["group_openid"]).ok_or("invalid-group")?,
                open_id(&author["member_openid"])
                    .or_else(|| open_id(&author["id"]))
                    .ok_or("invalid-sender")?,
            ),
            _ => return Err("unsupported-event"),
        };
        let id = event_message_id(data).ok_or("invalid-message-id")?;
        let enabled = match scope {
            QqScope::Private => inboxes.private_muse,
            QqScope::Group => inboxes.group_muse,
        };
        let text = data["content"].as_str().unwrap_or("").trim();
        let (content, mentioned) = if scope == QqScope::Group {
            group_text(
                text,
                &data["mentions"],
                bot_id,
                &api.app_id,
                kind == "GROUP_AT_MESSAGE_CREATE",
            )
        } else {
            (Cow::Borrowed(text), false)
        };
        let quote = (scope == QqScope::Group).then(|| quotes::Quote::from_event(data)).flatten();
        let own_quote = quote.as_ref().and_then(|quote| api.quotes.resolve(target, quote));
        let ambient = kind == "GROUP_MESSAGE_CREATE" && !mentioned && own_quote.is_none();
        if ambient && !(inboxes.group_muse && inboxes.group_muse_all) && inboxes.ambient.is_none() {
            return Err("ambient-disabled");
        }
        if ambient && !enabled && quote.is_some() {
            return Err("quote-addressed-elsewhere");
        }
        let now = crate::host::now_ms();
        let sent_at = data["timestamp"]
            .as_str()
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .and_then(|time| u64::try_from(time.timestamp_millis()).ok())
            .or_else(|| {
                let value = data["timestamp"]
                    .as_u64()
                    .or_else(|| data["timestamp"].as_str()?.parse().ok())?;
                Some(if value < 10_000_000_000 {
                    value * 1000
                } else {
                    value
                })
            });
        let received_at = sent_at.unwrap_or(now).min(now);
        if now.saturating_sub(received_at) >= scope.reply_window_ms() {
            return Err("reply-window-expired");
        }
        let attachments = &data["attachments"];
        let images = if enabled {
            incoming_images(attachments)
        } else {
            Vec::new()
        };
        let no_attachments =
            attachments.is_null() || attachments.as_array().is_some_and(Vec::is_empty);
        let text = match content.trim() {
            "" if mentioned && no_attachments => "@了你。",
            "" if images.is_empty() => return Err("empty-or-unsupported-content"),
            text => text,
        };
        let question = Self::muse_question(text, enabled);
        let unaddressed_command = if enabled {
            question.is_none()
        } else {
            text.starts_with(['/', '／'])
        };
        if ambient && unaddressed_command {
            // Unaddressed group commands must never pair a group or control a drawing.
            return Err("ambient-command");
        }
        Ok(Self {
            id: id.into(),
            target: target.into(),
            member: member.into(),
            group_role: members::role(&author["member_role"]),
            nickname: [
                &author["member_nickname"],
                &data["member"]["nick"],
                &author["nickname"],
                &author["username"],
            ]
            .into_iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .find(|name| !name.is_empty())
            .map(|name| name.chars().take(128).collect()),
            scope,
            to_muse: question.is_some(),
            ambient,
            quoted: own_quote.or_else(|| {
                mentioned.then_some(quote).flatten().map(|quote| {
                    quote.text.chars().take(480).collect()
                })
            }).filter(|text| !text.is_empty()),
            sent_at,
            text: question
                .map(|q| {
                    if q.is_empty() && !images.is_empty() {
                        format!("发来了 {} 张图片。", images.len())
                    } else {
                        q.to_owned()
                    }
                })
                .unwrap_or_else(|| text.chars().take(1600).collect()),
            images,
            received_at,
            arrived_at: Instant::now(),
        })
    }

    pub(super) fn destination(&self) -> Destination<'_> {
        Destination {
            scope: self.scope,
            id: &self.target,
        }
    }

    pub(super) fn pairing_request(&self) -> Option<(QqScope, &str)> {
        let (verb, code) = self.text.split_once(char::is_whitespace)?;
        let scope = match verb {
            "/绑定" => QqScope::Private,
            "/绑定群" => QqScope::Group,
            _ => return None,
        };
        Some((scope, code.trim()))
    }
}

fn incoming_images(attachments: &Value) -> Vec<Value> {
    attachments
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let mime = item["content_type"].as_str()?;
            if !mime.starts_with("image/") {
                return None;
            }
            let raw = item["url"].as_str()?.trim();
            if raw.len() > 4096 {
                return None;
            }
            let url = url::Url::parse(raw).ok()?;
            let host = url.domain()?;
            let qq_cdn = ["qq.com", "qq.com.cn", "qpic.cn", "qlogo.cn"]
                .iter()
                .any(|domain| {
                    host == *domain
                        || host
                            .strip_suffix(domain)
                            .is_some_and(|prefix| prefix.ends_with('.'))
                });
            if !qq_cdn
                || !matches!(url.scheme(), "https" | "http")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return None;
            }
            Some(json!({"mimeType":mime,"url":raw}))
        })
        .take(4)
        .collect()
}

fn group_text<'a>(
    text: &'a str,
    mentions: &Value,
    bot_id: Option<&str>,
    app_id: &str,
    at_event: bool,
) -> (Cow<'a, str>, bool) {
    let is_bot_id = |id: &str| Some(id) == bot_id || id == app_id;
    let own_mentions = mentions.as_array().into_iter().flatten().filter(|mention| {
        mention["scope"].as_str() != Some("all")
            && (mention["is_you"] == true
                || mention_ids(mention).any(is_bot_id))
    });
    let mut mentioned = at_event || own_mentions.clone().next().is_some();
    let mut cleaned = None;
    let mut start = 0;
    for mark in GROUP_MENTION.captures_iter(text) {
        let id = mark.get(1).or_else(|| mark.get(2)).unwrap().as_str();
        if is_bot_id(id) || own_mentions.clone().flat_map(mention_ids).any(|own| own == id) {
            let token = mark.get(0).unwrap();
            cleaned.get_or_insert_with(String::new).push_str(&text[start..token.start()]);
            start = token.end();
            mentioned = true;
        }
    }
    let content = if let Some(mut cleaned) = cleaned {
        cleaned.push_str(&text[start..]);
        Cow::Owned(cleaned)
    } else {
        Cow::Borrowed(text)
    };
    (content, mentioned)
}

fn mention_ids(mention: &Value) -> impl Iterator<Item = &str> {
    [&mention["member_openid"], &mention["id"]]
        .into_iter()
        .filter_map(open_id)
}

pub(super) fn event_message_id(data: &Value) -> Option<&str> {
    data["id"]
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 512)
}

pub(super) fn message_tag(id: &str) -> String {
    let mut digest = crate::storage::json_fingerprint(&json!(id));
    digest.truncate(12);
    digest
}

pub(super) fn muse_sender_id(conversation: &str, member: &str) -> String {
    crate::storage::json_fingerprint(&json!([conversation, member]))
}

pub(super) fn open_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        (1..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}
