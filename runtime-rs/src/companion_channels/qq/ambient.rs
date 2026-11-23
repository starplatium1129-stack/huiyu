use super::*;
use crate::chat::ChannelTurnOptions;
use std::{collections::VecDeque, sync::Mutex};

const CONTEXT_LIMIT: usize = 10;
const CONTEXT_AGE: Duration = Duration::from_secs(180);
const LATEST_AGE: Duration = Duration::from_secs(35);
const BATCH_DELAY: Duration = Duration::from_millis(2600);
const CHECK_INTERVAL: Duration = Duration::from_secs(18);
const REPLY_INTERVAL: Duration = Duration::from_secs(75);
const ADDRESS_PAUSE: Duration = Duration::from_secs(25);
const FOLLOW_UP_AGE: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(super) struct GroupChat {
    groups: Mutex<HashMap<String, Group>>,
}

#[derive(Default)]
struct Group {
    lines: VecDeque<Line>,
    pending_since: Option<Instant>,
    last_check: Option<Instant>,
    last_reply: Option<Instant>,
    last_addressed: Option<Instant>,
}

struct Line {
    id: String,
    member: String,
    nickname: Option<String>,
    text: String,
    at: Instant,
    addressed: bool,
    reply: Option<DeliveredReply>,
}

struct DeliveredReply {
    text: String,
    at: Instant,
}

struct Candidate {
    group: String,
    id: String,
    latest_member: String,
    owner: Option<String>,
    started: Instant,
    follow_up: bool,
    content: String,
}

impl GroupChat {
    pub(super) fn observe(&self, message: &Message) {
        if message.ambient
            && crate::host::now_ms().saturating_sub(message.received_at)
                > LATEST_AGE.as_millis() as u64
        {
            return;
        }
        let mut groups = self.groups.lock().unwrap();
        let group = groups.entry(message.target.clone()).or_default();
        if group.lines.iter().any(|line| line.id == message.id) {
            return;
        }
        let addressed = !message.ambient;
        if addressed {
            group.last_addressed = Some(message.arrived_at);
            group.pending_since = None;
        }
        if message.text.starts_with(['/', '／'])
            || message.text.contains("<@")
            || message.text.contains("<qqbot-at-user")
            || message
                .text
                .chars()
                .filter(|ch| ch.is_alphanumeric())
                .take(2)
                .count()
                < 2
        {
            return;
        }
        if !addressed {
            group.pending_since.get_or_insert(message.arrived_at);
        }
        group.lines.push_back(Line {
            id: message.id.clone(),
            member: message.member.clone(),
            nickname: message.nickname.clone(),
            text: message.text.chars().take(320).collect(),
            at: message.arrived_at,
            addressed,
            reply: None,
        });
        if group.lines.len() > CONTEXT_LIMIT {
            group.lines.pop_front();
        }
    }

    pub(super) fn remember_reply(&self, group: &str, message: &str, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let mut groups = self.groups.lock().unwrap();
        if let Some(line) = groups
            .get_mut(group)
            .and_then(|group| group.lines.iter_mut().find(|line| line.id == message))
        {
            line.reply = Some(DeliveredReply {
                text: text.chars().take(480).collect(),
                at: Instant::now(),
            });
        }
    }

    fn take_candidate(&self, bindings: &Bindings) -> Option<Candidate> {
        let now = Instant::now();
        let mut groups = self.groups.lock().unwrap();
        let (id, group) = groups
            .iter_mut()
            .filter(|(id, group)| {
                group.ready(now) && bindings.groups.iter().any(|bound| bound.id == **id)
            })
            .min_by_key(|(_, group)| group.last_check)?;
        let owner = bindings
            .groups
            .iter()
            .find(|group| group.id == *id)?
            .owner_member_id
            .clone();
        let latest = group.lines.back()?;
        let follow_up = group.is_follow_up(now);
        let lines = group
            .lines
            .iter()
            .filter(|line| now.duration_since(line.at) <= CONTEXT_AGE)
            .map(|line| {
                let speaker = if owner.as_deref() == Some(line.member.as_str()) {
                    "机主"
                } else {
                    line.nickname.as_deref().unwrap_or("群友")
                };
                json!({
                    "speaker":speaker,
                    "message":line.text,
                    "addressedToYou":line.addressed,
                    "sameSpeakerAsLatest":line.member == latest.member,
                    "yourReply":line.reply.as_ref().map(|reply| &reply.text),
                })
            })
            .collect::<Vec<_>>();
        let candidate = Candidate {
            group: id.clone(),
            id: latest.id.clone(),
            latest_member: latest.member.clone(),
            owner,
            started: now,
            follow_up,
            content: json!({"followsRecentReply":follow_up,"recent":lines}).to_string(),
        };
        group.last_check = Some(now);
        group.pending_since = None;
        Some(candidate)
    }

    fn still_relevant(&self, candidate: &Candidate) -> bool {
        let groups = self.groups.lock().unwrap();
        groups.get(&candidate.group).is_some_and(|group| {
            group.last_addressed.is_none_or(|at| at < candidate.started)
                && group
                    .lines
                    .iter()
                    .rev()
                    .take(4)
                    .any(|line| line.id == candidate.id && line.at.elapsed() <= LATEST_AGE)
        })
    }

    pub(super) async fn run(
        &self,
        app: &AppState,
        storage: &Storage,
        settings: &Settings,
        bindings: &RwLock<Bindings>,
        api: &Api,
        cancel: &CancellationToken,
    ) {
        let Some(chat) = app.chat.as_ref() else {
            return;
        };
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        while is_current(app, storage) {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tick.tick() => {}
            }
            let candidate = self.take_candidate(&bindings.read().unwrap());
            let Some(candidate) = candidate else { continue };
            let target = Destination {
                scope: QqScope::Group,
                id: &candidate.group,
            };
            let session = api.conversation_id(QqScope::Group, &candidate.group);
            let messages = [json!({"role":"user","content":candidate.content})];
            let result = tokio::time::timeout(
                Duration::from_secs(16),
                chat.channel_turn(
                    app,
                    &settings.character,
                    &session,
                    &messages,
                    ChannelTurnOptions {
                        in_group: true,
                        ambient_group: true,
                        is_owner: candidate.owner.as_deref()
                            == Some(candidate.latest_member.as_str()),
                        owner_bond: settings.owner_bond_kind(),
                        owner_call_name: &settings.owner_call_name,
                        owner_note: &settings.owner_note,
                        provider: settings.chat_provider_for(QqScope::Group),
                        ..Default::default()
                    },
                    cancel,
                ),
            )
            .await;
            if cancel.is_cancelled() || !is_current(app, storage) {
                return;
            }
            let tag = message_tag(&candidate.id);
            let follow_up = candidate.follow_up;
            let reply = match result {
                Ok(Ok(reply)) if reply.tools.is_empty() => match parse_reply(&reply.text) {
                    Ok(Some(reply)) => reply,
                    Ok(None) => {
                        eprintln!("QQ 群聊选择不接话：msg={tag} follow_up={follow_up}");
                        continue;
                    }
                    Err(()) => {
                        eprintln!("QQ 群聊接话判断结果无效：msg={tag} follow_up={follow_up}");
                        continue;
                    }
                },
                Ok(Ok(_)) => {
                    eprintln!("QQ 群聊接话判断返回操作：msg={tag} follow_up={follow_up}");
                    continue;
                }
                Ok(Err(error)) => {
                    eprintln!(
                        "QQ 群聊接话判断未完成：{} msg={tag} follow_up={follow_up}",
                        error.code
                    );
                    continue;
                }
                Err(_) => {
                    eprintln!("QQ 群聊接话判断超时：msg={tag} follow_up={follow_up}");
                    continue;
                }
            };
            if !bindings.read().unwrap().allows(target) || !self.still_relevant(&candidate) {
                eprintln!("QQ 群聊接话时机已过：msg={tag} follow_up={follow_up}");
                continue;
            }
            // Reserve the cooldown even if QQ leaves the delivery result uncertain.
            if let Some(group) = self.groups.lock().unwrap().get_mut(&candidate.group) {
                group.last_reply = Some(Instant::now());
            }
            match api.text(target, &candidate.id, &reply).await {
                Ok(()) => eprintln!("QQ 群聊自然接话已送达：msg={tag} follow_up={follow_up}"),
                Err(error) => eprintln!(
                    "QQ 群聊自然接话发送失败：{} msg={tag} follow_up={follow_up}",
                    error.code
                ),
            }
        }
    }
}

impl Group {
    fn is_follow_up(&self, now: Instant) -> bool {
        let Some(latest) = self.lines.back() else {
            return false;
        };
        self.lines
            .iter()
            .rev()
            .skip(1)
            .find_map(|line| line.reply.as_ref().map(|reply| (line, reply)))
            .is_some_and(|(line, reply)| {
                !latest.addressed
                    && line.member == latest.member
                    && self.last_addressed.is_none_or(|at| at <= line.at)
                    && latest.at > reply.at
                    && now.duration_since(reply.at) <= FOLLOW_UP_AGE
            })
    }

    fn ready(&self, now: Instant) -> bool {
        self.pending_since
            .is_some_and(|since| now.duration_since(since) >= BATCH_DELAY)
            && self
                .lines
                .back()
                .is_some_and(|line| !line.addressed && now.duration_since(line.at) <= LATEST_AGE)
            && self
                .last_check
                .is_none_or(|last| now.duration_since(last) >= CHECK_INTERVAL)
            && (self.is_follow_up(now)
                || (self
                    .last_reply
                    .is_none_or(|last| now.duration_since(last) >= REPLY_INTERVAL)
                    && self
                        .last_addressed
                        .is_none_or(|last| now.duration_since(last) >= ADDRESS_PAUSE)))
    }
}

fn parse_reply(output: &str) -> std::result::Result<Option<String>, ()> {
    let output = output.trim();
    let json = output
        .strip_prefix("```json")
        .and_then(|value| value.strip_suffix("```"))
        .unwrap_or(output);
    let value: Value = serde_json::from_str(json).map_err(|_| ())?;
    if value.get("reply").is_some_and(Value::is_null) {
        return Ok(None);
    }
    let reply = value["reply"].as_str().ok_or(())?.trim();
    if !reply.is_empty()
        && reply.chars().count() <= 140
        && !reply.starts_with(['/', '／'])
        && !reply.contains("<@")
    {
        Ok(Some(reply.to_owned()))
    } else {
        Err(())
    }
}
