use super::super::clean::{clean_cast_prose, clean_moss_reference_prose, is_wardrobe_token};
use super::super::ref_layout::NormalizedRefItem;
use super::lower_first;
use regex::Regex;
use std::sync::LazyLock;

static RE_LEAD_WRAP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:the |a |an )?(?:(?:foreground|background|left|right|central|center|front|rear|far|near) )*([a-z]+)-(wrapped|clad)\s+(?:character|subject|person|figure|woman|man|girl|boy)\b[,]?\s*")
        .unwrap()
});
static RE_LEAD_SUBJ: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:the |a |an )?(?:(?:foreground|background|left|right|central|center|front|rear|far|near|seated|standing|leaning|smiling|grinning|laughing) )*(?:character|subject|person|figure|woman|man|girl|boy)|she|he|they)\b(?:(?:\s*,\s*)|\s+(?:is|are)\s+|\s+)?")
        .unwrap()
});
static RE_MID_SUBJ: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([.!?]\s+)(?:the |a |an )?(?:(?:left|right|central|center|foreground|background) )?(?:character|subject|person|figure)\s+")
        .unwrap()
});
static RE_REF_VERB_OUTFIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[,;.]\s*|\s+)(?:(?:is|are)\s+)?((?:wears?|wearing|dressed in|clad in|outfitted in|wrapped in|draped in)\s+[^.!?;]+)")
        .unwrap()
});
static RE_REF_AFTER_CLOTHES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:\s+(?:while|beside|near|next to|in front of|at (?:a|an|the))\s+|",
        r"(?:\s*,\s*|\s+and\s+)(?:hold(?:s|ing)|stand(?:s|ing)|sit(?:s|ting)|seated|lean(?:s|ing)|walk(?:s|ing)|look(?:s|ing)|smil(?:es|ing)|laugh(?:s|ing)|glanc(?:es|ing)|rest(?:s|ing)|bracing|raising|reaching|kneeling|lying|turning|turned|wading)\b)",
    ))
    .unwrap()
});
static RE_REF_IN_OUTFIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^in\s+((?:a|an|the)\s+[^,.;!?]+?)(?:\s*,\s*|\s+(?:standing|stands?|sitting|sits?|seated|leaning|leans?|lying|lies|kneeling|holding|smiling|laughing|looking|glancing|turning|turned|walking|running|wading|facing|posing|tilting|tilts?)\b|[.!?;]|$)")
        .unwrap()
});
static RE_REF_STATE_OUTFIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b((?:(?:fully|completely|entirely|totally)\s+)?(?:nude|naked|unclothed|topless|bottomless|shirtless)|without (?:any )?clothes)\b")
        .unwrap()
});
static RE_OUTFIT_VERB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:wearing|dressed|clad|wrapped|draped|in\s+(?:a|an|the)\b|(?:(?:fully|completely|entirely|totally)\s+)?(?:nude|naked|topless|bottomless|shirtless|unclothed)|without (?:any )?clothes)\b")
        .unwrap()
});

static RE_WEAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:wears?|is wearing)\s+").unwrap());
static RE_FRAGMENT_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:and|with)\s+").unwrap());
static RE_ACTION_FRAGMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)^(?:hold(?:s|ing)|carry(?:ing|s)|carries|clutch(?:es|ing)|hang(?:s|ing)|stand(?:s|ing)|",
        r"sit(?:s|ting)|seated|lean(?:s|ing)|walk(?:s|ing)|look(?:s|ing)|smil(?:es|ing)|",
        r"laugh(?:s|ing)|glanc(?:es|ing)|rest(?:s|ing)|rais(?:es|ing)|reaching|kneeling|lying|turning|",
        r"touch(?:es|ing)|pull(?:s|ing)|tak(?:es|ing)|fac(?:es|ing)|waving)\b",
    ))
    .unwrap()
});

pub(super) fn format_outfit_clause(raw: &str) -> String {
    let cleaned = clean_cast_prose(raw);
    let cleaned = cleaned.trim_end_matches(['.', '!', '?']).trim();
    if matches!(cleaned.to_ascii_lowercase().as_str(),
        "" | "none" | "n/a" | "unknown" | "not visible" | "not shown" | "out of frame"
            | "no visible clothing" | "clothing not visible" | "clothing is not visible"
            | "not clearly visible" | "not discernible" | "unspecified"
    ) {
        return String::new();
    }
    if let Some(wear) = RE_WEAR.find(cleaned) {
        return format!("wearing {}", &cleaned[wear.end()..]);
    }
    if RE_OUTFIT_VERB.is_match(cleaned) {
        return lower_first(cleaned);
    }
    let body = if cleaned.starts_with("A ") || cleaned.starts_with("An ") || cleaned.starts_with("The ") {
        lower_first(cleaned)
    } else {
        cleaned.to_owned()
    };
    format!("wearing {body}")
}

fn strip_leading_reference_subject(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let replaced = RE_LEAD_WRAP.replace(trimmed, |cap: &regex::Captures<'_>| {
        if cap[2].eq_ignore_ascii_case("wrapped") {
            format!("wrapped in a {}, ", &cap[1])
        } else {
            format!("in a {}, ", &cap[1])
        }
    });
    let stripped = RE_LEAD_SUBJ.replace(&replaced, "");
    let mid_clean = RE_MID_SUBJ.replace_all(&stripped, "$1");
    mid_clean.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';')).trim().to_owned()
}

fn extract_reference_outfit_and_pose(raw: &str) -> (String, String) {
    let text = strip_leading_reference_subject(&clean_cast_prose(raw));
    if text.is_empty() {
        return (String::new(), String::new());
    }
    if let Some(cap) = RE_REF_VERB_OUTFIT.captures(&text)
        && let (Some(full), Some(inner)) = (cap.get(0), cap.get(1))
    {
        let mut clause = inner.as_str().trim().to_owned();
        let mut tail = String::new();
        if let Some(rest) = RE_REF_AFTER_CLOTHES.find(&clause)
            && rest.start() > 0
        {
            tail = clause[rest.start()..].to_owned();
            clause = clause[..rest.start()].trim().to_owned();
        }
        let sep = full.as_str().chars().next().filter(|c| matches!(c, '.' | '!' | '?' | ';')).map(|c| c.to_string()).unwrap_or_default();
        let pose = clean_cast_prose(&format!("{}{sep} {tail} {}", &text[..full.start()], &text[full.end()..]));
        return (format_outfit_clause(&clause), pose);
    }
    if let Some(cap) = RE_REF_IN_OUTFIT.captures(&text)
        && let (Some(full), Some(inner)) = (cap.get(0), cap.get(1))
        && is_wardrobe_token(inner.as_str())
    {
        let outfit = format_outfit_clause(&format!("wearing {}", inner.as_str().trim()));
        let end = if full.as_str().ends_with(|c: char| c.is_ascii_alphabetic()) {
            inner.end()
        } else {
            full.end()
        };
        let pose = clean_cast_prose(&text[end..]);
        return (outfit, pose);
    }
    if let Some(cap) = RE_REF_STATE_OUTFIT.captures(&text)
        && let (Some(full), Some(inner)) = (cap.get(0), cap.get(1))
    {
        let pose = clean_cast_prose(&format!("{} {}", &text[..full.start()], &text[full.end()..]));
        return (inner.as_str().trim().to_ascii_lowercase(), pose);
    }
    (String::new(), text)
}

fn split_clothing_fragments(text: &str, mut outfit: String) -> (String, String) {
    let mut pose = String::new();
    for fragment in text.split_inclusive([',', ';', '.', '!', '?']) {
        let bare = fragment.trim().trim_end_matches([',', ';', '.', '!', '?']).trim();
        let item = RE_FRAGMENT_LINK.replace(bare, "");
        if is_wardrobe_token(&item) && !RE_ACTION_FRAGMENT.is_match(&item) {
            if outfit.is_empty() {
                outfit = format_outfit_clause(&item);
            } else {
                outfit.push_str(", ");
                outfit.push_str(&item);
            }
        } else {
            pose.push_str(fragment);
        }
    }
    (outfit, pose)
}

pub(super) fn reference_clothing_and_pose(
    item: &NormalizedRefItem,
    identity_terms: &[String],
) -> (String, String) {
    let (legacy_outfit, legacy_pose) = extract_reference_outfit_and_pose(&item.caption);
    let (legacy_outfit, legacy_pose) = split_clothing_fragments(&legacy_pose, legacy_outfit);
    let clothing_only = |text: &str| {
        let cleaned = strip_leading_reference_subject(&clean_moss_reference_prose(text, identity_terms, false));
        let description = cleaned.split([',', ';', '.', '!', '?'])
            .map(str::trim)
            .filter(|part| !part.is_empty() && !RE_ACTION_FRAGMENT.is_match(part))
            .collect::<Vec<_>>()
            .join(", ");
        format_outfit_clause(&description)
    };
    let structured_outfit = item.clothing.as_deref()
        .map(clothing_only)
        .unwrap_or_default();
    let clean_pose = |text: &str| {
        strip_leading_reference_subject(&clean_moss_reference_prose(text, identity_terms, true))
    };
    let structured_pose = item.pose.as_deref().map(|text| {
        let (_, pose) = extract_reference_outfit_and_pose(text);
        let (_, pose) = split_clothing_fragments(&pose, String::new());
        clean_pose(&pose)
    }).unwrap_or_default();
    (
        if structured_outfit.is_empty() { clothing_only(&legacy_outfit) } else { structured_outfit },
        if structured_pose.is_empty() { clean_pose(&legacy_pose) } else { structured_pose },
    )
}
