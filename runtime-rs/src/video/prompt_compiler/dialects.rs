use super::supports_negative;
use super::super::*;

pub(super) struct PromptParts<'a> {
    pub anchor: &'a str,
    pub framing: &'a str,
    pub subject: &'a str,
    pub description: &'a str,
    pub action: &'a str,
    pub fallback_motion: &'a str,
    pub camera: &'a str,
    pub atmosphere: &'a str,
    pub ending: &'a str,
    pub sound: &'a str,
    pub score: &'a str,
    pub dialogue: &'a str,
    pub input_mode: &'a str,
    pub duration: u64,
    pub h3: bool,
    pub ltx: bool,
    pub kandinsky: bool,
    pub english: bool,
}

pub(super) fn sentence(text: &str, english: bool) -> String {
    let text = text.trim();
    if text.is_empty() || text.ends_with(['.', '!', '?', '。', '！', '？', '…']) {
        text.to_owned()
    } else {
        format!("{text}{}", if english { "." } else { "。" })
    }
}

pub(super) fn negative_prompt(
    model: &Value,
    requested: &str,
    quiet: bool,
    text: bool,
) -> Option<String> {
    if !supports_negative(model) {
        return None;
    }
    let family = model["family"].as_str().unwrap_or("");
    if !matches!(family, "wan2.2" | "hunyuan" | "hunyuan-video-1.5") {
        return (!requested.is_empty()).then(|| requested.to_owned());
    }
    let base = catalog::constants()["WAN_NEGATIVE"].as_str().unwrap_or("");
    let mut terms = Vec::new();
    for term in [base, requested]
        .into_iter()
        .flat_map(|s| s.split(['，', ',', '、', '\n', ';', '；']))
        .map(str::trim)
    {
        let key = term.to_ascii_lowercase();
        if term.is_empty()
            || (quiet
                && matches!(
                    key.as_str(),
                    "静态"
                        | "静止"
                        | "定格"
                        | "静止不动"
                        | "静止不动的画面"
                        | "static"
                        | "still"
                        | "motionless"
                        | "no motion"
                        | "freeze frame"
                ))
            || (text
                && matches!(
                    key.as_str(),
                    "字幕"
                        | "文字"
                        | "屏幕文字"
                        | "字样"
                        | "text"
                        | "subtitles"
                        | "captions"
                        | "on-screen text"
                ))
            || terms.contains(&term)
        {
            continue;
        }
        terms.push(term);
    }
    (!terms.is_empty()).then(|| terms.join("，"))
}

// Kandinsky's short shots use a sentence for the opening, one for the motion
// and one for the landing. Join paired single-clause fragments smoothly.
fn kandinsky_sentence(parts: &[&str]) -> String {
    let items: Vec<&str> = parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect();
    match items.as_slice() {
        [] => String::new(),
        [only] => sentence(only, true),
        [first, second] if !first.contains(". ") && !second.contains(". ") => {
            let head = first.trim_end_matches('.');
            let tail = second.trim_end_matches('.');
            let mut chars = tail.chars();
            let Some(initial) = chars.next() else {
                return sentence(head, true);
            };
            let mut prose = String::with_capacity(head.len() + tail.len() + 7);
            prose.push_str(head);
            prose.push_str(", and ");
            prose.extend(initial.to_lowercase());
            prose.push_str(chars.as_str());
            sentence(&prose, true)
        }
        _ => items
            .into_iter()
            .map(|part| sentence(part, true))
            .collect::<Vec<_>>()
            .join(" "),
    }
}

pub(super) fn format_prompt(parts: PromptParts<'_>) -> String {
    let visual = [
        parts.anchor,
        parts.framing,
        parts.subject,
        parts.description,
        parts.action,
        parts.fallback_motion,
        parts.camera,
        parts.atmosphere,
        parts.ending,
    ];
    if parts.kandinsky {
        let opening = kandinsky_sentence(&[parts.anchor, parts.framing, parts.subject]);
        let motion = kandinsky_sentence(&[
            parts.action,
            parts.fallback_motion,
            parts.camera,
            parts.atmosphere,
        ]);
        let finish = kandinsky_sentence(&[parts.ending, parts.sound]);
        join(&[&opening, parts.description, &motion, &finish], " ")
    } else if parts.h3 {
        let visual = join(&[&join(&visual, " "), parts.dialogue], " ");
        let score = if parts.score.is_empty() {
            "N/A"
        } else {
            parts.score
        };
        let content = format!(
            "integrated_multimodal_description: [Shot 1] {visual}\n\noverall_soundscape: {}\n\nnon_diegetic_music: {score}",
            parts.sound
        );
        match prose::h3_alignment(
            parts.input_mode != "text",
            parts.input_mode == "first-last-frame",
            parts.duration,
        ) {
            Some(alignment) => format!("{alignment}\n\n{content}"),
            None => content,
        }
    } else if parts.ltx {
        let score = if parts.score.eq_ignore_ascii_case("N/A") {
            "The scene plays without background music."
        } else {
            parts.score
        };
        join(
            &[
                &join(&visual, " "),
                &sentence(parts.sound, true),
                parts.dialogue,
                &sentence(score, true),
            ],
            " ",
        )
    } else if parts.english {
        join(&visual, " ")
    } else {
        join_zh(&visual)
    }
}

fn join(parts: &[&str], separator: &str) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(separator)
}

fn join_zh(parts: &[&str]) -> String {
    let mut out = String::new();
    for part in parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
    {
        if !out.is_empty() && !out.ends_with(['。', '！', '？', '…']) {
            out.push(' ');
        }
        out.push_str(part);
    }
    out
}
