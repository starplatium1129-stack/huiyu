use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

const SENT_LIMIT: usize = 32;
const TEXT_LIMIT: usize = 1600;

#[derive(Default)]
pub(super) struct SentQuotes(Mutex<HashMap<String, VecDeque<Sent>>>);

struct Sent {
    id: Option<String>,
    index: Option<String>,
    text: String,
}

pub(super) struct Quote<'a> {
    index: Option<&'a str>,
    pub text: &'a str,
}

impl<'a> Quote<'a> {
    pub(super) fn from_event(data: &'a Value) -> Option<Self> {
        let index = data["message_scene"]["ext"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.as_str()?.strip_prefix("ref_msg_idx="))
            .find(|index| valid_index(index));
        if index.is_none() && data["message_type"] != 103 {
            return None;
        }
        let first = &data["msg_elements"][0];
        Some(Self {
            index: index.or_else(|| first["msg_idx"].as_str().filter(|id| valid_index(id))),
            text: first["content"].as_str().unwrap_or("").trim(),
        })
    }
}

impl SentQuotes {
    pub(super) fn remember(&self, group: &str, receipt: &Value, text: &str) {
        self.insert(
            group,
            Sent {
                id: receipt["id"]
                    .as_str()
                    .filter(|id| valid_index(id))
                    .map(str::to_owned),
                index: receipt["ext_info"]["ref_idx"]
                    .as_str()
                    .filter(|id| valid_index(id))
                    .map(str::to_owned),
                text: text.trim().chars().take(TEXT_LIMIT).collect(),
            },
        );
    }

    pub(super) fn restore_text(&self, group: &str, text: &str) {
        if text.trim().chars().count() >= 16 {
            self.insert(
                group,
                Sent {
                    id: None,
                    index: None,
                    text: text.trim().chars().take(TEXT_LIMIT).collect(),
                },
            );
        }
    }

    pub(super) fn resolve(&self, group: &str, quote: &Quote<'_>) -> Option<String> {
        let groups = self.0.lock().unwrap();
        let messages = groups.get(group)?;
        let receipt = quote
            .index
            .and_then(|index| {
                messages.iter().rev().find(|message| {
                    message.index.as_deref() == Some(index) || message.id.as_deref() == Some(index)
                })
            })
            .or_else(|| {
                // An older conversation or a legacy QQ receipt can lack an index.
                if quote.text.chars().take(16).count() < 16 || quote.text.len() > TEXT_LIMIT * 4 {
                    return None;
                }
                messages
                    .iter()
                    .rev()
                    .find(|message| message.index.is_none() && message.text == quote.text)
            })?;
        Some(if receipt.text.is_empty() {
            quote.text.chars().take(TEXT_LIMIT).collect()
        } else {
            receipt.text.clone()
        })
    }

    fn insert(&self, group: &str, message: Sent) {
        let mut groups = self.0.lock().unwrap();
        let messages = groups.entry(group.to_owned()).or_default();
        if messages.len() == SENT_LIMIT {
            messages.pop_front();
        }
        messages.push_back(message);
    }
}

fn valid_index(index: &str) -> bool {
    !index.is_empty() && index.len() <= 512
}
