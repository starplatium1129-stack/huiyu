use super::*;
use std::collections::HashSet;

const STORED_MESSAGES: usize = 96;
const RECENT_MESSAGES: usize = 16;
const RECENT_TEXT_LIMIT: usize = 6000;
const STORED_PHOTOS: usize = 4;

#[derive(Deserialize, Serialize)]
pub(super) struct Photo {
    batch: String,
    description: Option<String>,
    count: usize,
}

pub(super) fn trim(history: &mut Vec<Value>, qq: bool) {
    let limit = if qq { STORED_MESSAGES } else { 12 };
    let excess = history.len().saturating_sub(limit);
    history.drain(..excess);
}

pub(super) fn remember_photo(photos: &mut Vec<Photo>, batch: &Batch) {
    if let Some(photo) = photos.iter_mut().find(|photo| photo.batch == batch.id) {
        photo.count = batch.delivered;
        return;
    }
    photos.push(Photo {
        batch: batch.id.clone(),
        description: batch.photo_description.clone(),
        count: batch.delivered,
    });
    if photos.len() > STORED_PHOTOS {
        photos.remove(0);
    }
}

pub(super) fn context(
    history: &[Value],
    photos: &[Photo],
    in_group: bool,
) -> (Vec<Value>, Vec<String>) {
    let mut used = 0;
    let recent_count = history
        .iter()
        .rev()
        .take(RECENT_MESSAGES)
        .take_while(|message| {
            used += message["content"]
                .as_str()
                .unwrap_or("")
                .encode_utf16()
                .count();
            used <= RECENT_TEXT_LIMIT
        })
        .count();
    let (older, recent) = history.split_at(history.len() - recent_count);
    let query = recent
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .and_then(|message| message["content"].as_str())
        .unwrap_or("");
    let terms = pairs(utterance(query, in_group));
    let mut notes = Vec::new();
    for (i, photo) in photos.iter().rev().take(2).enumerate() {
        let label = if i == 0 {
            "最近发过"
        } else {
            "再上一批发过"
        };
        let detail = photo.description.as_deref().unwrap_or("未记录画面描述");
        notes.push(format!("{label} {} 张图。{detail}", photo.count));
    }

    let mut matches = older
        .iter()
        .enumerate()
        .rev()
        .filter_map(|(i, message)| {
            let line = message["content"].as_str()?;
            (message["role"] == "user").then(|| {
                (
                    i,
                    pairs(utterance(line, in_group))
                        .intersection(&terms)
                        .count(),
                    line,
                )
            })
        })
        .collect::<Vec<_>>();
    // Keep one recent piece of older context, then prefer excerpts that match the new topic.
    let nearest = matches.first().map(|entry| entry.0);
    matches
        .sort_unstable_by_key(|&(i, score, _)| (Some(i) != nearest, std::cmp::Reverse((score, i))));
    for (i, score, line) in matches {
        if notes.len() == 4 {
            break;
        }
        if score < 2 && Some(i) != nearest {
            continue;
        }
        let line: String = line.trim().chars().take(100).collect();
        let label = if in_group {
            "之前的群聊记录"
        } else {
            "对方在之前聊天里提过"
        };
        let note = format!("{label}：“{line}”");
        if !line.is_empty() && !notes.contains(&note) {
            notes.push(note);
        }
    }
    (recent.to_vec(), notes)
}

fn utterance(text: &str, in_group: bool) -> &str {
    if in_group {
        text.split_once('：').map_or(text, |(_, spoken)| spoken)
    } else {
        text
    }
}

fn pairs(text: &str) -> HashSet<(char, char)> {
    text.chars()
        .zip(text.chars().skip(1))
        .filter(|(a, b)| a.is_alphanumeric() && b.is_alphanumeric())
        .collect()
}
