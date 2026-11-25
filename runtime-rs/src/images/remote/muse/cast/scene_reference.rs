use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::clean::{
    clean_cast_prose, clean_moss_reference_prose, ensure_sentence, is_reference_appearance_token,
    is_wardrobe_token, normalize_key, public_tags,
};

static CAMERA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)\b(?:close[ -]up|face focus|upper body|full body|wide[ -]angle|(?:wide|medium|cowboy|long) shot|",
        r"camera|framing|portrait|depth of field|(?:high|low|dutch) angle|",
        r"from (?:above|below|behind|the side)|point of view|pov)\b",
    ))
    .unwrap()
});
static SUBJECT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:(?:the|a|an|another|first|second|left|right|central|front|rear|one|two|three|four|five|adult|young|tall|short)\s+)*(?:she|he|they|her|his|their|subject|character|figure|person|people|girl|boy|woman|man|women|men)s?\b",
    )
    .unwrap()
});
static ACTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)^(?:stand(?:s|ing)?|sit(?:s|ting)?|seated|lying|kneel(?:s|ing)?|crouch(?:es|ing)?|",
        r"lean(?:s|ing)?|hold(?:s|ing)?|hand holding|carrying|looking|gazing|facing|eye contact|",
        r"walk(?:s|ing)?|running|smil(?:e|es|ing)|blush(?:es|ing)?|grin(?:s|ning)?|waving|",
        r"hug(?:s|ging)?|kiss(?:es|ing)?|embrac(?:es?|ing)|hug from behind|reaching|crossed|hands?|arms?)\b",
    ))
    .unwrap()
});
static PLACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)\b(?:next to|beside|behind|under|beneath|across|amid|outside|inside|against|at|by|in(?: front of)?|on|near)\s+",
        r"(?:(?:a|an|the)\s+|(?:(?:soft|warm|cool|dim|bright|neon|morning|afternoon|evening)\s+){0,4}",
        r"(?:rain|snow|mist|sunlight|moonlight|daylight|dawn|dusk|light|glow)\b)",
    ))
    .unwrap()
});

pub(super) fn tags(values: &[String], local_keys: &HashSet<String>) -> Vec<String> {
    public_tags(values)
        .into_iter()
        .filter_map(|token| {
            let key = normalize_key(&token);
            if key.is_empty() || local_keys.contains(&key) || is_wardrobe_token(&token) {
                return None;
            }
            if ACTION.is_match(&key) {
                return None;
            }
            if is_reference_appearance_token(&token) || SUBJECT.is_match(&key) {
                return CAMERA.find(&key).map(|camera| camera.as_str().to_owned());
            }
            Some(token)
        })
        .collect()
}

pub(super) fn caption(value: &str, identity_terms: &[String]) -> String {
    let cleaned = clean_cast_prose(&clean_moss_reference_prose(value, identity_terms, true));
    cleaned
        .split_terminator(['.', ';', '!', '?'])
        .filter_map(|sentence| {
            let parts = sentence
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .filter_map(|part| {
                    let action = ACTION.is_match(part);
                    if !action && !SUBJECT.is_match(part) && !is_wardrobe_token(part)
                        && !is_reference_appearance_token(part)
                    {
                        return Some(part);
                    }
                    if !action && let Some(camera) = CAMERA.find(part) {
                        return Some(camera.as_str());
                    }
                    PLACE.find_iter(part).map(|place| &part[place.start()..]).find(|setting| {
                        !is_wardrobe_token(setting) && !is_reference_appearance_token(setting)
                    })
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| ensure_sentence(&parts.join(", ")))
        })
        .collect::<Vec<_>>()
        .join(" ")
}
