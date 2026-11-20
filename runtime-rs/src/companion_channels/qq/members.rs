use super::{API, Api, Duration, Instant, Message, QqScope, Value};
use std::collections::VecDeque;

pub(super) fn role(value: &Value) -> Option<&'static str> {
    match value.as_str()? {
        "owner" => Some("owner"),
        "admin" => Some("admin"),
        "member" => Some("member"),
        _ => None,
    }
}

struct Profile {
    group: String,
    member: String,
    role: &'static str,
    nickname: Option<String>,
    expires: Instant,
}

#[derive(Default)]
pub(super) struct Directory {
    profiles: VecDeque<Profile>,
    lookups: VecDeque<Instant>,
    retry_after: Option<Instant>,
}

impl Directory {
    pub(super) async fn enrich(&mut self, api: &Api, message: &mut Message) {
        if message.scope != QqScope::Group {
            return;
        }
        let now = Instant::now();
        self.profiles.retain(|p| p.expires > now);
        let previous = self
            .profiles
            .iter()
            .position(|p| p.group == message.target && p.member == message.member);
        if let Some(i) = previous {
            let cached = &mut self.profiles[i];
            if message.nickname.is_some() {
                cached.nickname.clone_from(&message.nickname);
            } else {
                message.nickname.clone_from(&cached.nickname);
            }
            if message.group_role.is_none() {
                message.group_role = Some(cached.role);
                return;
            }
            self.profiles.remove(i);
        }

        // Both group events normally carry author.member_role. Older events can
        // omit it. QQ's member-detail API has a 30 requests/minute quota.
        if message.group_role.is_none() {
            self.lookups
                .retain(|at| now.duration_since(*at) < Duration::from_secs(60));
            if self.lookups.len() >= 30 || self.retry_after.is_some_and(|at| at > now) {
                return;
            }
            self.lookups.push_back(now);
            let url = format!(
                "{API}/v2/groups/{}/members/{}",
                message.target, message.member
            );
            let lookup = api.authenticated(api.client.get(url));
            match tokio::time::timeout(Duration::from_secs(2), lookup).await {
                Ok(Ok(data)) if data["member_openid"].as_str() == Some(message.member.as_str()) => {
                    message.group_role = role(&data["member_role"]);
                    if message.nickname.is_none() {
                        message.nickname = data["username"]
                            .as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.chars().take(128).collect());
                    }
                }
                Ok(Err(error)) if error.code == "QQ_PERMISSION_DENIED" => {
                    self.retry_after = Some(now + Duration::from_secs(300));
                }
                _ => self.retry_after = Some(now + Duration::from_secs(5)),
            }
        }
        if let Some(role) = message.group_role {
            if role == "owner" {
                self.profiles
                    .retain(|p| p.group != message.target || p.role != "owner");
            }
            if self.profiles.len() >= 256 {
                self.profiles.pop_front();
            }
            self.profiles.push_back(Profile {
                group: message.target.clone(),
                member: message.member.clone(),
                role,
                nickname: message.nickname.clone(),
                expires: now + Duration::from_secs(300),
            });
        }
    }
}
