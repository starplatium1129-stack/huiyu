use super::Event;
use serde_json::Value;
use std::collections::VecDeque;

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
            "\n【本轮角色语音】直接用 [[voice-ja]]日语台词[[/voice-ja]] 开头（原有情绪标签放在它前面），关闭标签后再写同一内容的中文。",
            "第一段日语用一句简短、完整的口语。后续有新消息时，先换一个空行，再按同样的日语、中文顺序继续。",
            "例如：[[voice-ja]]慌てなくていいよ。[[/voice-ja]]不用着急。\n\n[[voice-ja]]ゆっくり話して。[[/voice-ja]]你慢慢说。",
            "日语保留中文对白的意思、称呼和语气，只写对白，不读动作描写、情绪标签或说明，全部日语合计最多 500 字。",
            "代码和列表保留在中文部分，日语只用一句话简短介绍。",
            "需要调用工具时先调用，拿到工具结果后，再用这个格式回复。"
        ));
    }
}

#[derive(Default)]
pub(super) struct JapaneseVoice {
    buffer: String,
    reading: bool,
    oversized: bool,
    speech: String,
}

impl JapaneseVoice {
    pub(super) fn push(&mut self, content: String, events: &mut VecDeque<Event>, speak: bool) {
        if !self.reading && self.buffer.is_empty() && !content.contains('[') {
            events.push_back(Event::Token { content });
            return;
        }
        self.buffer.push_str(&content);
        let mut display = String::new();
        while !self.buffer.is_empty() {
            let marker = if self.reading { CLOSE } else { OPEN };
            if let Some(index) = self.buffer.find(marker) {
                if self.reading {
                    let text = self.buffer[..index].trim();
                    if speak {
                        if !display.is_empty() {
                            events.push_back(Event::Token {
                                content: std::mem::take(&mut display),
                            });
                        }
                        // An empty block keeps the following text eligible for fallback speech.
                        let content =
                            if !self.oversized && Self::record_speech(&mut self.speech, text) {
                                text.to_owned()
                            } else {
                                String::new()
                            };
                        events.push_back(Event::JapaneseSpeechChunk { content });
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
        if !display.is_empty() {
            events.push_back(Event::Token { content: display });
        }
    }

    fn record_speech(speech: &mut String, text: &str) -> bool {
        let separator = usize::from(!speech.is_empty());
        if speech.chars().count() + separator + text.chars().take(MAX_CHARS + 1).count() > MAX_CHARS
            || !text.chars().any(crate::voice::is_kana)
        {
            return false;
        }
        if separator != 0 {
            speech.push('\n');
        }
        speech.push_str(text);
        true
    }

    pub(super) fn finish(self, events: &mut VecDeque<Event>) {
        if !self.reading && !self.buffer.is_empty() {
            events.push_back(Event::Token {
                content: self.buffer,
            });
        }
        // Clients that only support the terminal transcript still receive the complete script.
        if !self.speech.is_empty() {
            events.push_back(Event::JapaneseSpeech {
                content: self.speech,
            });
        }
    }
}
