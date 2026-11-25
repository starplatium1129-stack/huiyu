use super::clean::{clean_cast_prose, public_tags};
use super::input::{format_custom_outfit_caption, is_clear_outfit_sentinel};
use super::ResolvedActor;
use super::super::*;
use std::sync::LazyLock;

#[derive(serde::Deserialize)]
struct StudioOutfitDef {
    character: String,
    aliases: Vec<String>,
    tags: Vec<String>,
    prose: String,
}

static STUDIO_OUTFITS: LazyLock<Vec<StudioOutfitDef>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("studio_outfits.json"))
        .expect("studio_outfits.json must be valid")
});

pub(super) fn studio_character_id(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    match trimmed {
        "nene" | "宁宁" | "绫地宁宁" | "綾地寧々" => Some("nene"),
        "natsume" | "夏目" | "四季夏目" | "四季ナツメ" => Some("natsume"),
        _ => match trimmed.to_ascii_lowercase().as_str() {
            "nene" | "ayachi_nene" | "ayachi nene" => Some("nene"),
            "natsume" | "shiki_natsume" | "shiki natsume" => Some("natsume"),
            _ => None,
        },
    }
}

fn find_studio_outfit(character: &str, outfit_id: &str) -> Option<&'static StudioOutfitDef> {
    let stripped = outfit_id
        .trim()
        .strip_prefix("studio/")
        .unwrap_or(outfit_id.trim());
    STUDIO_OUTFITS.iter().find(|def| {
        def.character == character
            && def
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(stripped))
    })
}

fn default_studio_outfit(character: &str) -> &'static StudioOutfitDef {
    let default_alias = if character == "nene" {
        "neneSchool"
    } else {
        "natsumeCafe"
    };
    find_studio_outfit(character, default_alias).expect("default studio outfit must exist")
}

pub(super) fn resolve_studio_actor(
    character: &'static str,
    outfit_id: Option<&str>,
    outfit_prompt: Option<&str>,
    outfit_explicit: Option<bool>,
    action: String,
    bbox: Option<[f64; 4]>,
    wardrobe_db: Option<&Connection>,
) -> Result<ResolvedActor> {
    let trimmed_id = outfit_id.map(str::trim).filter(|s| !s.is_empty());
    let trimmed_prompt = outfit_prompt.map(str::trim).filter(|s| !s.is_empty());
    if let (Some(id), Some(_)) = (trimmed_id, trimmed_prompt)
        && !is_clear_outfit_sentinel(id)
    {
        return Err(ApiError::invalid(
            "同一角色请只传 outfitId 或 outfitPrompt 中的一项（自定义服装时省略 outfitId 或设为 none）",
        ));
    }

    let (outfit_tags, outfit_caption, explicit) = if let Some(custom) = trimmed_prompt {
        let cleaned = clean_cast_prose(custom);
        (
            public_tags(&[&cleaned]),
            format_custom_outfit_caption(&cleaned),
            true,
        )
    } else if let Some(requested) = trimmed_id {
        if is_clear_outfit_sentinel(requested) {
            if matches!(requested.to_ascii_lowercase().as_str(), "nude" | "naked") {
                (vec!["nude".into()], "Nude.".into(), true)
            } else {
                (Vec::new(), String::new(), true)
            }
        } else if let Some(def) = find_studio_outfit(character, requested) {
            (
                public_tags(&def.tags),
                format!("Wearing {}.", def.prose),
                outfit_explicit.unwrap_or(true),
            )
        } else if let Some(db) = wardrobe_db {
                let key = if requested.starts_with("studio/") {
                    requested.to_owned()
                } else {
                    format!("studio/{requested}")
                };
                let row: Option<(String, String)> = db
                    .query_row(
                        "SELECT character, tags FROM studio_wardrobe WHERE id=?1",
                        [&key],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                let Some((owner_char, tags_json)) = row else {
                    return Err(ApiError::new(
                        404,
                        "CAST_OUTFIT_NOT_FOUND",
                        format!("未找到角色 {character} 的服装 {requested}"),
                    ));
                };
                if owner_char != character {
                    return Err(ApiError::new(
                        422,
                        "CAST_OUTFIT_MISMATCH",
                        format!("服装 {requested} 属于角色 {owner_char}，不能穿在 {character} 身上"),
                    ));
                }
                let raw_tags: Vec<String> =
                    serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
                let tags = public_tags(&raw_tags);
                let prose = if tags.is_empty() {
                    String::new()
                } else {
                    format!(
                        "Wearing {}.",
                        tags.iter()
                            .map(|t| t.replace('_', " "))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
            (tags, prose, outfit_explicit.unwrap_or(true))
        } else {
            return Err(ApiError::new(
                404,
                "CAST_OUTFIT_NOT_FOUND",
                format!("未找到角色 {character} 的服装 {requested}"),
            ));
        }
    } else {
        let def = default_studio_outfit(character);
        (
            public_tags(&def.tags),
            format!("Wearing {}.", def.prose),
            outfit_explicit.unwrap_or(false),
        )
    };

    if character == "nene" {
        let identity = public_tags(&[
            "ayachi_nene",
            "white_hair",
            "low_twintails",
            "purple_eyes",
            "pink_hair_ribbons",
        ]);
        let mut aliases = vec!["Ayachi Nene".into(), "宁宁".into(), "绫地宁宁".into()];
        aliases.extend(identity.iter().cloned());
        Ok(ResolvedActor {
            key: "studio:nene".into(),
            name: "Ayachi Nene".into(),
            character_tokens: vec!["ayachi_nene".into()],
            copyright_tokens: vec!["sanoba_witch".into()],
            aliases,
            identity_tokens: identity,
            outfit_tokens: outfit_tags,
            identity_caption: clean_cast_prose(
                "Ayachi Nene, a woman with white hair, purple eyes, an ahoge, and pink hair ribbons.",
            ),
            outfit_caption,
            outfit_explicit: explicit,
            action,
            bbox,
            gender: "girl",
        })
    } else {
        let identity = public_tags(&[
            "shiki_natsume",
            "black_hair",
            "long_hair",
            "yellow_eyes",
            "mole_under_eye",
            "hairclip",
        ]);
        let mut aliases = vec!["Shiki Natsume".into(), "夏目".into(), "四季夏目".into()];
        aliases.extend(identity.iter().cloned());
        Ok(ResolvedActor {
            key: "studio:natsume".into(),
            name: "Shiki Natsume".into(),
            character_tokens: vec!["shiki_natsume".into()],
            copyright_tokens: vec!["cafe_stella_to_shinigami_no_chou".into()],
            aliases,
            identity_tokens: identity,
            outfit_tokens: outfit_tags,
            identity_caption: clean_cast_prose(
                "Shiki Natsume, a woman with black hair, golden-yellow eyes, two red hairclips, and a small mole beneath one eye.",
            ),
            outfit_caption,
            outfit_explicit: explicit,
            action,
            bbox,
            gender: "girl",
        })
    }
}
