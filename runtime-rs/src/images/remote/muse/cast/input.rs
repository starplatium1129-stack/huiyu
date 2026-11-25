use super::super::*;

pub(super) const MAX_CAST_MEMBERS: usize = 5;
pub(super) const MAX_ACTION_CHARS: usize = 600;
pub(super) const MAX_OUTFIT_PROMPT_CHARS: usize = 400;
pub(super) const MAX_INTERACTION_CHARS: usize = 1000;

#[derive(Clone, Copy, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum CastGender {
    #[default]
    Girl,
    Boy,
    Other,
}

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in super::super) struct CastMemberInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) character_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) appearance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) gender: Option<CastGender>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) outfit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) outfit_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) outfit_explicit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) bbox: Option<[f64; 4]>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CastMemberObject {
    #[serde(default, alias = "character")]
    character_id: Option<String>,
    name: Option<String>,
    appearance: Option<String>,
    gender: Option<CastGender>,
    #[serde(default, alias = "outfit")]
    outfit_id: Option<String>,
    #[serde(default, alias = "customOutfit", alias = "outfitText")]
    outfit_prompt: Option<String>,
    #[serde(default)]
    outfit_explicit: Option<bool>,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    bbox: Option<[f64; 4]>,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum CastMemberRepr {
    Shorthand(String),
    Object(CastMemberObject),
}

impl<'de> serde::Deserialize<'de> for CastMemberInput {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match CastMemberRepr::deserialize(deserializer)? {
            CastMemberRepr::Object(obj) => Ok(Self {
                character_id: obj.character_id,
                name: obj.name,
                appearance: obj.appearance,
                gender: obj.gender,
                outfit_id: obj.outfit_id,
                outfit_prompt: obj.outfit_prompt,
                outfit_explicit: obj.outfit_explicit,
                action: obj.action,
                bbox: obj.bbox,
            }),
            CastMemberRepr::Shorthand(raw) => parse_shorthand(&raw).map_err(serde::de::Error::custom),
        }
    }
}

fn parse_shorthand(raw: &str) -> std::result::Result<CastMemberInput, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("cast 成员不能为空字符串");
    }
    let Some((char_part, rest)) = trimmed.split_once(':') else {
        return Ok(CastMemberInput {
            character_id: Some(trimmed.to_owned()),
            ..Default::default()
        });
    };
    let character_id = char_part.trim();
    if character_id.is_empty() {
        return Err("cast 简写缺少角色 ID，格式为 角色ID[:服装ID|=自定义服装|none][:动作]");
    }
    let (outfit_part, action_part) = match rest.split_once(':') {
        Some((o, a)) => (o.trim(), a.trim()),
        None => (rest.trim(), ""),
    };
    let (outfit_id, outfit_prompt, outfit_explicit) = if let Some(custom) = outfit_part.strip_prefix('=') {
        let custom = custom.trim();
        if custom.is_empty() {
            return Err("cast 简写中 = 后面需要填写自定义服装描述");
        }
        (None, Some(custom.to_owned()), Some(true))
    } else if !outfit_part.is_empty() {
        (Some(outfit_part.to_owned()), None, Some(true))
    } else {
        (None, None, None)
    };
    let action = (!action_part.is_empty()).then(|| action_part.to_owned());
    Ok(CastMemberInput {
        character_id: Some(character_id.to_owned()),
        outfit_id,
        outfit_prompt,
        outfit_explicit,
        action,
        ..Default::default()
    })
}

impl CastMemberInput {
    pub(super) fn is_custom(&self) -> bool {
        self.character_id.as_deref().is_none_or(|id| {
            ["custom", "original", "oc"].iter().any(|value| id.trim().eq_ignore_ascii_case(value))
        })
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(untagged)]
pub(in super::super) enum InteractionInput {
    Single(String),
    List(Vec<String>),
}

impl<'de> serde::Deserialize<'de> for InteractionInput {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Single(String),
            List(Vec<String>),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Single(s) => Ok(Self::Single(s)),
            Raw::List(list) => Ok(Self::List(list)),
        }
    }
}

impl InteractionInput {
    pub(super) fn normalize(&self) -> Result<String> {
        let joined = match self {
            Self::Single(s) => s.trim().to_owned(),
            Self::List(list) => list
                .iter()
                .map(|item| item.trim())
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
        };
        let normalized = joined.replace(['\r', '\n'], " ");
        let trimmed = normalized.trim();
        if trimmed.chars().count() > MAX_INTERACTION_CHARS {
            return Err(ApiError::invalid(format!(
                "interaction 互动描述不能超过 {MAX_INTERACTION_CHARS} 字"
            )));
        }
        Ok(trimmed.to_owned())
    }
}

pub(super) fn is_clear_outfit_sentinel(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "none" | "custom" | "clear" | "off" | "naked" | "nude"
    )
}

pub(super) fn format_custom_outfit_caption(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_ascii_lowercase();
    let already_clause = [
        "wearing ",
        "dressed ",
        "clad ",
        "in a ",
        "in an ",
        "in her ",
        "in his ",
        "in their ",
        "nude",
        "naked",
        "topless",
        "bottomless",
        "unclothed",
        "bare",
        "without ",
        "no clothes",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
        || !trimmed.is_ascii();
    if already_clause {
        if trimmed.ends_with(['.', '!', '?', '。', '！', '？']) {
            trimmed.to_owned()
        } else {
            format!("{trimmed}.")
        }
    } else {
        format!("Wearing {}.", trimmed.trim_end_matches('.'))
    }
}

pub(super) fn validate_member_bbox(bbox: [f64; 4], name: &str) -> Result<[f64; 4]> {
    let [y1, x1, y2, x2] = bbox;
    if !(y1.is_finite()
        && x1.is_finite()
        && y2.is_finite()
        && x2.is_finite()
        && (0.0..=1.0).contains(&y1)
        && (0.0..=1.0).contains(&y2)
        && y1 < y2
        && (0.0..=1.0).contains(&x1)
        && (0.0..=1.0).contains(&x2)
        && x1 < x2)
    {
        return Err(ApiError::invalid(format!(
            "角色 {name} 的 bbox 须为 0..1 归一化坐标 [y1, x1, y2, x2]，且 y1 < y2、x1 < x2"
        )));
    }
    Ok(bbox)
}
