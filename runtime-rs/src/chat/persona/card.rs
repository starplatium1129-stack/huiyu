use super::{HISTORY_LIMIT, length};
use super::super::{Error, Result};
use serde::Deserialize;
use serde_json::Value;
use std::sync::LazyLock;

#[derive(Deserialize)]
struct CharacterCard {
    data: CardData,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(in crate::chat) struct CardData {
    pub name: String,
    pub(super) system_prompt: String,
    pub description: String,
    pub first_mes: String,
    alternate_greetings: Vec<String>,
    pub(super) personality: String,
    pub(super) scenario: String,
    pub(super) mes_example: String,
    pub(super) post_history_instructions: String,
    pub(super) extensions: CardExtensions,
    pub(super) character_book: Option<Lorebook>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct CardExtensions {
    pub(super) depth_prompt: Option<DepthPrompt>,
    huiyu: Value,
}

#[derive(Deserialize)]
pub(super) struct DepthPrompt {
    pub(super) prompt: String,
    #[serde(default = "default_depth")]
    pub(super) depth: usize,
}

fn default_depth() -> usize {
    1
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Lorebook {
    scan_depth: Option<usize>,
    entries: Vec<LoreEntry>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct LoreEntry {
    keys: Vec<String>,
    secondary_keys: Vec<String>,
    enabled: Option<bool>,
    constant: bool,
    selective: bool,
    case_sensitive: bool,
    use_regex: bool,
    insertion_order: i64,
    content: String,
}

impl Lorebook {
    pub(super) fn context(&self, body: &Value) -> Vec<&str> {
        // Search only dialogue text. Never scan base64 images or tool payloads.
        let recent = body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .filter(|m| matches!(m["role"].as_str(), Some("user" | "assistant")))
            .take(self.scan_depth.unwrap_or(4).min(HISTORY_LIMIT))
            .flat_map(|m| {
                let content = &m["content"];
                content.as_str().into_iter().chain(
                    content
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|p| p["type"] == "text")
                        .filter_map(|p| p["text"].as_str()),
                )
            })
            .map(|s| s.chars().take(1200).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        let folded = recent.to_lowercase();
        let mut entries = self
            .entries
            .iter()
            .filter(|entry| {
                let found = |key: &String| {
                    !key.is_empty()
                        && if entry.case_sensitive {
                            recent.contains(key)
                        } else {
                            folded.contains(&key.to_lowercase())
                        }
                };
                entry.enabled != Some(false)
                    && !entry.content.trim().is_empty()
                    && (entry.constant
                        || (!entry.use_regex
                            && entry.keys.iter().any(found)
                            && (!entry.selective || entry.secondary_keys.iter().any(found))))
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.insertion_order);
        let mut remaining = 2400usize;
        entries
            .into_iter()
            .filter_map(|entry| {
                let size = length(&entry.content);
                remaining = remaining.checked_sub(size)?;
                Some(entry.content.as_str())
            })
            .collect()
    }
}

impl CardData {
    pub(in crate::chat) fn catalog_id(&self) -> Option<&str> {
        self.extensions.huiyu["character_id"].as_str().filter(|id| {
            !id.is_empty()
                && id.len() <= 80
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
    }

    pub(in crate::chat) fn greeting(&self) -> &str {
        if self.first_mes.trim().is_empty() {
            self.alternate_greetings
                .iter()
                .find(|s| !s.trim().is_empty())
                .map_or("", String::as_str)
        } else {
            &self.first_mes
        }
    }

    pub(in crate::chat) fn validate_import(&self) -> Result<()> {
        if self.name.trim().is_empty()
            || length(&self.name) > 80
            || self.name.chars().any(char::is_control)
        {
            return Err(Error::invalid("角色名不能为空、含控制符或超过 80 字"));
        }
        if length(self.greeting()) > 16000 {
            return Err(Error::invalid("开场白超过 16000 字"));
        }
        Ok(())
    }
}

static NENE: LazyLock<CharacterCard> =
    LazyLock::new(|| serde_json::from_str(include_str!("../cards/nene.json")).expect("Nene card"));
static NATSUME: LazyLock<CharacterCard> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../cards/natsume.json")).expect("Natsume card")
});

pub(super) fn builtin(character: &str) -> Option<&'static CardData> {
    match character {
        "nene" => Some(&NENE.data),
        "natsume" => Some(&NATSUME.data),
        _ => None,
    }
}
