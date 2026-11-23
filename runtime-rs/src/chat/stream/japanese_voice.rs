use super::Event;
use serde_json::Value;

const OPEN: &str = "[[voice-ja]]";
const CLOSE: &str = "[[/voice-ja]]";
const MAX_CHARS: usize = 500;

pub(in crate::chat) fn prompt(messages: &mut [Value]) {
    if let Some(system) = messages
        .first_mut()
        .filter(|message| message["role"] == "system")
        && let Some(Value::String(content)) = system.get_mut("content")
    {
        content.push_str(concat!(
            "\n【本轮角色语音】照常用中文写给用户看的回复，内容结束后另起一行附上日语朗读稿。",
            "格式为 [[voice-ja]]日语台词[[/voice-ja]]，只加一组，放在回复末尾。",
            "日语台词要和中文对白意思、称呼和语气一致，写成自然口语，不读动作描写、标签或说明，最多 500 字。",
            "如果这轮只需要调用工具，等拿到工具结果、写最终回复时再附日语台词。"
        ));
    }
}

#[derive(Default)]
pub(super) struct JapaneseVoice {
    buffer: String,
    reading: bool,
    oversized: bool,
    speech: Option<String>,
}

impl JapaneseVoice {
    pub(super) fn push(&mut self, content: String) -> Option<Event> {
        if !self.reading && self.buffer.is_empty() && !content.contains('[') {
            return Some(Event::Token { content });
        }
        self.buffer.push_str(&content);
        let mut display = String::new();
        while !self.buffer.is_empty() {
            let marker = if self.reading { CLOSE } else { OPEN };
            if let Some(index) = self.buffer.find(marker) {
                if self.reading {
                    let text = self.buffer[..index].trim();
                    if !self.oversized
                        && self.speech.is_none()
                        && text.chars().take(MAX_CHARS + 1).count() <= MAX_CHARS
                        && text.chars().any(crate::voice::is_kana)
                    {
                        self.speech = Some(text.to_owned());
                    }
                } else {
                    display.push_str(&self.buffer[..index]);
                }
                self.buffer = self.buffer.split_off(index + marker.len());
                self.reading = !self.reading;
                self.oversized = false;
                continue;
            }
            if self.reading && !self.oversized && self.buffer.len() <= MAX_CHARS * 4 + CLOSE.len() {
                break;
            }
            // A delimiter may straddle any upstream event. Keep only its
            // possible prefix, forwarding any text outside the speech block.
            let keep = (1..marker.len())
                .rev()
                .find(|&len| self.buffer.ends_with(&marker[..len]))
                .unwrap_or(0);
            let pending = self.buffer.split_off(self.buffer.len() - keep);
            if self.reading {
                self.oversized = true;
            } else {
                display.push_str(&self.buffer);
            }
            self.buffer = pending;
            break;
        }
        (!display.is_empty()).then_some(Event::Token { content: display })
    }

    pub(super) fn finish(self) -> [Option<Event>; 2] {
        [
            (!self.reading && !self.buffer.is_empty()).then_some(Event::Token {
                content: self.buffer,
            }),
            self.speech.map(|content| Event::JapaneseSpeech { content }),
        ]
    }
}
