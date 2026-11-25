use super::ResolvedActor;
use super::clean::{clean_cast_prose, ensure_sentence, public_tags};
use super::input::{CastGender, CastMemberInput, format_custom_outfit_caption, is_clear_outfit_sentinel};
use super::super::*;

pub(super) fn resolve_custom_actor(
    member: &CastMemberInput,
    index: usize,
    action: String,
    bbox: Option<[f64; 4]>,
) -> Result<ResolvedActor> {
    let name = member.name.as_deref().unwrap_or_default().trim();
    let appearance = member.appearance.as_deref().unwrap_or_default().trim();
    if name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(ApiError::invalid("原创角色的 name 须为不超过 80 字的单行文字"));
    }
    if appearance.chars().count() > 400 {
        return Err(ApiError::invalid("原创角色的 appearance 不能超过 400 字"));
    }
    if name.is_empty() && appearance.is_empty() {
        return Err(ApiError::invalid("原创角色至少需要填写 name 或 appearance"));
    }

    let (gender, subject) = match member.gender.unwrap_or_default() {
        CastGender::Girl => ("girl", "a girl"),
        CastGender::Boy => ("boy", "a boy"),
        CastGender::Other => ("other", "a person"),
    };
    let identity_tokens = public_tags(&[if appearance.is_empty() { name } else { appearance }]);
    let identity_caption = [name, subject, appearance]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let identity_caption = ensure_sentence(&clean_cast_prose(&identity_caption));

    let outfit_id = member.outfit_id.as_deref().unwrap_or_default().trim();
    let outfit_prompt = member.outfit_prompt.as_deref().unwrap_or_default().trim();
    if !outfit_id.is_empty() && !is_clear_outfit_sentinel(outfit_id) {
        return Err(ApiError::invalid(
            "原创角色请用 outfitPrompt 描述服装，outfitId 可省略或用于清空默认服",
        ));
    }
    let (outfit_tokens, outfit_caption) = if !outfit_prompt.is_empty() {
        let cleaned = clean_cast_prose(outfit_prompt);
        (public_tags(&[&cleaned]), format_custom_outfit_caption(&cleaned))
    } else if matches!(outfit_id.to_ascii_lowercase().as_str(), "nude" | "naked") {
        (vec!["nude".into()], "Nude.".into())
    } else {
        (Vec::new(), String::new())
    };
    let aliases = (!name.is_empty()).then(|| name.to_owned()).into_iter().collect();
    let name = if name.is_empty() {
        format!("Original character {}", index + 1)
    } else {
        name.to_owned()
    };

    Ok(ResolvedActor {
        key: format!("custom:{index}"),
        name,
        character_tokens: Vec::new(),
        copyright_tokens: Vec::new(),
        aliases,
        identity_tokens,
        outfit_tokens,
        identity_caption,
        outfit_caption,
        outfit_explicit: member.outfit_explicit == Some(true)
            || !outfit_id.is_empty()
            || !outfit_prompt.is_empty(),
        action,
        bbox,
        gender,
    })
}
