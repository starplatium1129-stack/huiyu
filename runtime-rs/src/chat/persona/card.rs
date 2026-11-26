use super::{HISTORY_LIMIT, length};
use super::super::{Error, Result};
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
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
    token_budget: Option<usize>,
    recursive_scanning: Option<bool>,
    entries: Vec<LoreEntry>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(in crate::chat) struct ExternalLorebook {
    pub entries: Vec<LoreEntry>,
    pub budget: Option<usize>,
    pub recursive: Option<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::chat) enum LorePosition {
    BeforeChar,
    AfterChar,
    AtDepth(usize),
}

pub(in crate::chat) struct LoreMatch {
    pub title: String,
    pub content: String,
    pub position: LorePosition,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(in crate::chat) struct LoreEntry {
    #[serde(alias = "name")]
    pub comment: String,
    #[serde(alias = "key")]
    pub keys: Vec<String>,
    #[serde(alias = "keysecondary")]
    pub secondary_keys: Vec<String>,
    pub enabled: Option<bool>,
    pub disable: Option<bool>,
    pub constant: bool,
    pub selective: bool,
    pub case_sensitive: bool,
    pub use_regex: bool,
    pub whole_words: bool,
    #[serde(alias = "order")]
    pub insertion_order: i64,
    pub position: Value,
    pub depth: Option<usize>,
    pub content: String,
}

impl LoreEntry {
    fn is_enabled(&self) -> bool {
        self.enabled != Some(false) && self.disable != Some(true)
    }

    fn parsed_position(&self) -> LorePosition {
        let depth = self.depth.unwrap_or(4).min(16);
        match &self.position {
            Value::String(raw) => match raw.trim() {
                "before_char" | "0" => LorePosition::BeforeChar,
                "at_depth" | "4" => LorePosition::AtDepth(depth),
                _ => LorePosition::AfterChar,
            },
            Value::Number(num) => match num.as_i64() {
                Some(0) => LorePosition::BeforeChar,
                Some(4) => LorePosition::AtDepth(depth),
                _ => LorePosition::AfterChar,
            },
            _ => LorePosition::AfterChar,
        }
    }

    fn title(&self) -> String {
        let comment = self.comment.trim();
        if !comment.is_empty() {
            return comment.chars().take(48).collect();
        }
        if let Some(first_key) = self.keys.iter().find(|k| !k.trim().is_empty()) {
            return first_key.trim().chars().take(32).collect();
        }
        if self.constant {
            return "常驻设定".into();
        }
        "世界书条目".into()
    }
}

fn parse_slash_regex(key: &str) -> (&str, Option<bool>) {
    if let Some(rest) = key.strip_prefix('/')
        && let Some(end) = rest.rfind('/')
    {
        let body = &rest[..end];
        let flags = &rest[end + 1..];
        if !body.is_empty() && flags.chars().all(|c| matches!(c, 'i' | 'm' | 's' | 'u' | 'g')) {
            return (body, Some(flags.contains('i')));
        }
    }
    (key, None)
}

fn contains_whole_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    // Whole-word boundary check only applies cleanly to ASCII tokens; CJK falls back to substring.
    if !needle.is_ascii() {
        return haystack.contains(needle);
    }
    let bytes = haystack.as_bytes();
    let mut start = 0usize;
    while let Some(offset) = haystack[start..].find(needle) {
        let pos = start + offset;
        let before_ok = pos == 0 || !bytes[pos - 1].is_ascii_alphanumeric() && bytes[pos - 1] != b'_';
        let after_idx = pos + needle.len();
        let after_ok = after_idx >= bytes.len()
            || (!bytes[after_idx].is_ascii_alphanumeric() && bytes[after_idx] != b'_');
        if before_ok && after_ok {
            return true;
        }
        start = pos + 1;
    }
    false
}

fn key_matches(haystack: &str, folded: &str, key: &str, entry: &LoreEntry) -> bool {
    let key = key.trim();
    if key.is_empty() || key.len() > 256 {
        return false;
    }
    let (slash_body, slash_ci) = if entry.use_regex || (key.starts_with('/') && key.matches('/').count() >= 2) {
        parse_slash_regex(key)
    } else {
        (key, None)
    };
    if entry.use_regex || slash_ci.is_some() {
        let case_insensitive = slash_ci.unwrap_or(!entry.case_sensitive);
        return RegexBuilder::new(slash_body)
            .case_insensitive(case_insensitive)
            .size_limit(64 * 1024)
            .dfa_size_limit(64 * 1024)
            .build()
            .is_ok_and(|re| re.is_match(haystack));
    }
    if entry.case_sensitive {
        if entry.whole_words {
            contains_whole_word(haystack, key)
        } else {
            haystack.contains(key)
        }
    } else {
        let key_folded = key.to_lowercase();
        if entry.whole_words {
            contains_whole_word(folded, &key_folded)
        } else {
            folded.contains(&key_folded)
        }
    }
}

fn entry_matches(entry: &LoreEntry, haystack: &str, folded: &str) -> bool {
    if entry.constant {
        return true;
    }
    let primary = entry
        .keys
        .iter()
        .any(|key| key_matches(haystack, folded, key, entry));
    if !primary {
        return false;
    }
    if entry.selective && !entry.secondary_keys.is_empty() {
        return entry
            .secondary_keys
            .iter()
            .any(|key| key_matches(haystack, folded, key, entry));
    }
    true
}

pub(in crate::chat) fn match_lore(
    card_book: Option<&Lorebook>,
    external: Option<&ExternalLorebook>,
    body: &Value,
) -> Vec<LoreMatch> {
    let scan_depth = card_book
        .and_then(|b| b.scan_depth)
        .unwrap_or(12)
        .clamp(1, 40)
        .min(HISTORY_LIMIT.max(12));
    let base_text = body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .filter(|m| matches!(m["role"].as_str(), Some("user" | "assistant")))
        .take(scan_depth)
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

    let mut pool: Vec<&LoreEntry> = Vec::new();
    if let Some(book) = card_book {
        pool.extend(
            book.entries
                .iter()
                .filter(|e| e.is_enabled() && !e.content.trim().is_empty()),
        );
    }
    if let Some(ext) = external {
        pool.extend(
            ext.entries
                .iter()
                .filter(|e| e.is_enabled() && !e.content.trim().is_empty()),
        );
    }
    if pool.is_empty() {
        return Vec::new();
    }
    pool.sort_by_key(|entry| entry.insertion_order);

    let recursive = external
        .and_then(|e| e.recursive)
        .or_else(|| card_book.and_then(|b| b.recursive_scanning))
        .unwrap_or(false);
    let mut remaining = external
        .and_then(|e| e.budget)
        .or_else(|| card_book.and_then(|b| b.token_budget))
        .unwrap_or(4000)
        .clamp(500, 16000);

    let max_rounds = if recursive { 3 } else { 1 };
    let mut scan_text = base_text;
    let mut selected_indices: Vec<usize> = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();

    for _round in 0..max_rounds {
        let folded = scan_text.to_lowercase();
        let mut newly_added = String::new();
        for (idx, entry) in pool.iter().enumerate() {
            if seen.contains(&idx) {
                continue;
            }
            if entry_matches(entry, &scan_text, &folded) {
                let size = length(entry.content.trim());
                if size <= remaining {
                    remaining -= size;
                    seen.insert(idx);
                    selected_indices.push(idx);
                    if recursive {
                        newly_added.push('\n');
                        newly_added.push_str(entry.content.trim());
                    }
                }
            }
        }
        if newly_added.is_empty() {
            break;
        }
        scan_text.push_str(&newly_added);
    }

    selected_indices.sort_unstable_by_key(|&idx| (pool[idx].insertion_order, idx));
    selected_indices
        .into_iter()
        .map(|idx| {
            let entry = pool[idx];
            LoreMatch {
                title: entry.title(),
                content: entry.content.trim().to_owned(),
                position: entry.parsed_position(),
            }
        })
        .collect()
}

impl Lorebook {
    pub(in crate::chat) fn len(&self) -> usize {
        self.entries.len()
    }
}

impl CardData {
    pub(in crate::chat) fn lore_count(&self) -> usize {
        self.character_book.as_ref().map_or(0, |book| book.len())
    }

    pub(in crate::chat) fn catalog_id(&self) -> Option<&str> {
        self.extensions.huiyu["character_id"].as_str().filter(|id| {
            !id.is_empty()
                && id.len() <= 80
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
    }

    pub(in crate::chat) fn voice_id(&self) -> Option<&str> {
        self.extensions.huiyu["voice_id"].as_str().map(str::trim).filter(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .enumerate()
                    .all(|(idx, b)| {
                        b.is_ascii_lowercase()
                            || b.is_ascii_digit()
                            || (idx > 0 && matches!(b, b'_' | b'-'))
                    })
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

    pub(in crate::chat) fn greetings(&self) -> Vec<&str> {
        let mut out = Vec::new();
        for candidate in std::iter::once(self.first_mes.as_str())
            .chain(self.alternate_greetings.iter().map(String::as_str))
        {
            if candidate.trim().is_empty() || length(candidate) > 16000 {
                continue;
            }
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
        out
    }

    pub(in crate::chat) fn validate_import(&self) -> Result<()> {
        if self.name.trim().is_empty()
            || length(&self.name) > 80
            || self.name.chars().any(char::is_control)
        {
            return Err(Error::invalid("角色名不能为空、含控制符或超过 80 字"));
        }
        if length(self.greeting()) > 16000
            || self
                .alternate_greetings
                .iter()
                .any(|item| !item.trim().is_empty() && length(item) > 16000)
        {
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
