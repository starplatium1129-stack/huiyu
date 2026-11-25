use crate::storage::Storage;
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub(super) struct Connection {
    pub(super) epoch: String,
    pub(super) phase: &'static str,
    pub(super) detail: Option<&'static str>,
}

pub(super) struct Pairing {
    pub(super) epoch: String,
    pub(super) code: String,
    pub(super) expires_at: u64,
    pub(super) label: String,
}

impl Pairing {
    pub(super) fn is_current(&self, storage: &Storage) -> bool {
        self.epoch == storage.runtime_epoch() && self.expires_at > crate::host::now_ms()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum QqScope {
    Private,
    Group,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum QqPairKind {
    Owner,
    Friend,
    Group,
}

impl QqPairKind {
    pub(super) fn scope(self) -> QqScope {
        match self {
            Self::Owner | Self::Friend => QqScope::Private,
            Self::Group => QqScope::Group,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum QqChatProvider {
    #[default]
    Default,
    Chatgpt,
    ChatgptPrivate,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum QqVoiceMode {
    #[default]
    Off,
    OnDemand,
    Auto,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum QqOwnerBond {
    #[default]
    Default,
    Close,
    Intimate,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QqGroup {
    pub(super) id: String,
    pub(super) label: String,
    #[serde(default)]
    pub(super) owner_member_id: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct QqFriend {
    pub(super) id: String,
    pub(super) label: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Settings {
    #[serde(default = "default_bot_id")]
    pub(super) id: String,
    #[serde(default)]
    pub(super) name: String,
    pub(super) app_id: String,
    pub(super) sealed_secret: String,
    pub(super) character: String,
    #[serde(default)]
    pub(super) chat_provider: QqChatProvider,
    #[serde(default)]
    pub(super) owner_bond: QqOwnerBond,
    #[serde(default)]
    pub(super) owner_call_name: String,
    #[serde(default)]
    pub(super) owner_note: String,
    #[serde(default)]
    pub(super) voice_mode: QqVoiceMode,
    #[serde(default)]
    pub(super) group_voice: bool,
    #[serde(default = "default_voice_profile")]
    pub(super) voice_profile: String,
    pub(super) enabled: bool,
    pub(super) drawing: bool,
    pub(super) owner: Option<String>,
    #[serde(default)]
    pub(super) friends: Vec<QqFriend>,
    #[serde(default)]
    pub(super) group_drawing: bool,
    #[serde(default)]
    pub(super) group_natural_replies: bool,
    #[serde(default)]
    pub(super) group_muse: bool,
    #[serde(default)]
    pub(super) private_muse: bool,
    #[serde(default)]
    pub(super) group_muse_all: bool,
    #[serde(default = "default_muse_context_limit")]
    pub(super) muse_context_limit: usize,
    #[serde(default)]
    pub(super) muse_proactive: bool,
    // Ordinary restarts keep the same history. A new binding/settings session starts fresh.
    #[serde(default)]
    pub(super) muse_history_generation: String,
    #[serde(default)]
    pub(super) groups: Vec<QqGroup>,
}

pub(super) fn default_bot_id() -> String {
    "default".into()
}

pub(super) fn default_voice_profile() -> String {
    "auto".into()
}

pub(super) fn default_muse_context_limit() -> usize {
    32
}

impl Settings {
    pub(super) fn same_connection(&self, other: &Self) -> bool {
        let mut comparable = self.clone();
        comparable.muse_context_limit = other.muse_context_limit;
        comparable.friends.clone_from(&other.friends);
        comparable == *other
    }

    pub(super) fn muse_for(&self, scope: QqScope, target: &str) -> bool {
        match scope {
            QqScope::Private => self.private_muse && self.owner.as_deref() == Some(target),
            QqScope::Group => self.group_muse,
        }
    }

    pub(super) fn uses_muse(&self) -> bool {
        self.private_muse || self.group_muse
    }

    pub(super) fn chat_provider_for(&self, scope: QqScope) -> crate::chat::ChannelProvider {
        match (self.chat_provider, scope) {
            (QqChatProvider::Chatgpt, _) | (QqChatProvider::ChatgptPrivate, QqScope::Private) => {
                crate::chat::ChannelProvider::ChatGpt
            }
            _ => crate::chat::ChannelProvider::Default,
        }
    }

    pub(super) fn owner_bond_kind(&self) -> crate::chat::ChannelOwnerBond {
        match self.owner_bond {
            QqOwnerBond::Default => crate::chat::ChannelOwnerBond::Default,
            QqOwnerBond::Close => crate::chat::ChannelOwnerBond::Close,
            QqOwnerBond::Intimate => crate::chat::ChannelOwnerBond::Intimate,
        }
    }

    pub(super) fn voice_for(&self, scope: QqScope) -> (bool, bool) {
        let enabled = match scope {
            QqScope::Private => self.voice_mode != QqVoiceMode::Off,
            QqScope::Group => self.voice_mode != QqVoiceMode::Off && self.group_voice,
        };
        (enabled, enabled && self.voice_mode == QqVoiceMode::Auto)
    }
}
