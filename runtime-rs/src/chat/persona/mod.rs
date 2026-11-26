mod card;
mod prompt;
mod tools;

use serde_json::Value;
use std::borrow::Cow;

pub(super) const HISTORY_LIMIT: usize = 24;
pub(super) const TEXT_LIMIT: usize = 12000;
pub(in crate::chat) const MAX_HISTORY_LIMIT: usize = 120;
pub(in crate::chat) const MAX_TEXT_LIMIT: usize = 120_000;
pub(in crate::chat) const MAX_MESSAGE_LENGTH: usize = 16_000;

pub(super) use card::{CardData, ExternalLorebook};
pub(super) use prompt::{
    AffectionContext, RpOptions, SceneStateContext, build, build_with_options,
    single_system_messages,
};
pub(super) use tools::{channel_tools, known_tool, tools};

pub(super) fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(super) fn string(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(false) => String::new(),
        Value::Number(n) if n.as_f64() == Some(0.0) => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => {
            let mut output = String::new();
            append_array(values, &mut output);
            output
        }
        other => crate::storage::stringify(other),
    }
}

pub(super) fn trimmed_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_owned(),
        _ => string(value).trim().to_owned(),
    }
}

fn append_array(values: &[Value], output: &mut String) {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        match value {
            Value::Null => {}
            Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Value::Number(number) if number.as_f64() == Some(0.0) => output.push('0'),
            Value::String(text) => output.push_str(text),
            Value::Object(_) => output.push_str("[object Object]"),
            Value::Array(nested) => append_array(nested, output),
            other => output.push_str(&string(other)),
        }
    }
}

fn clean(value: &Value) -> String {
    let source = match value {
        Value::String(text) => Cow::Borrowed(text.as_str()),
        _ => Cow::Owned(string(value)),
    };
    let mut output = String::new();
    let mut pending_space = false;
    for ch in source.chars() {
        if ch.is_control() || ch == '\u{feff}' || ch.is_whitespace() {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
            }
            output.push(ch);
            pending_space = false;
        }
    }
    output
}
