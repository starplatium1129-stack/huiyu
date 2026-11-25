use super::super::*;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum CastFormation {
    #[default]
    Row,
    Staggered,
    Close,
}

impl CastFormation {
    pub(super) fn parse(raw: Option<&str>) -> Result<Self> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("row") => Ok(Self::Row),
            Some("staggered") => Ok(Self::Staggered),
            Some("close" | "intimate") => Ok(Self::Close),
            Some(_) => Err(ApiError::invalid(
                "formation 仅支持 row（并排）、close（贴近互动）或 staggered（前后排错落）",
            )),
        }
    }
}

static RE_LORA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<lora:[^>]*>").unwrap());
static RE_PRIVATE_CTRL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:nene|natsume)_[a-z0-9_]+\b").unwrap());
static RE_CAST_COUNT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^(?:\d+\+?\s*(?:girls?|boys?|people|persons?|women|woman|men|man|others?|subjects?|characters?)|",
        r"solo(?: focus)?|single (?:subject|character|person|figure)|",
        r"only (?:one )?(?:subject|character|person|figure)|",
        r"multiple (?:girls|boys|people|subjects|characters)|",
        r"no humans|duo|trio|two shot|threesome|couple proximity framing)$"
    ))
    .unwrap()
});
static RE_NEG_COUNT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^(?:(?:multiple|second|third|extra|additional|another|two|three|four|five|\d+\+?) ",
        r"(?:visible )?(?:characters?|subjects?|persons?|figures?|people|girls?|boys?|women|woman|men|man)|",
        r"group (?:shot|portrait|photo)|crowd|duo|trio|",
        r"more than (?:one|1) (?:persons?|figures?|characters?|girls?|boys?))$"
    ))
    .unwrap()
});
static RE_PROSE_ONLY_CHAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bis the only (?:prominent |visible )?(?:character|subject|person|figure),?\s*")
        .unwrap()
});
static RE_PROSE_ONLY_FRAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i),?\s+the only (?:prominent |visible )?(?:character|subject|person|figure) in the (?:image|frame|shot)\b,?")
        .unwrap()
});
static RE_PROSE_NO_OTHER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:there (?:is|are) )?(?:no (?:other|second)|without (?:another|a second)) (?:person|people|subject|character|figure)s?(?: (?:is |are )?(?:visible|present|in (?:the )?(?:frame|shot)))?\b")
        .unwrap()
});
static RE_PROSE_SOLO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:solo(?:[ _]focus)?|single[ _](?:subject|character|person|figure)|\d+[ _]?(?:girls?|boys?)|(?:alone|by (?:her|him|them)self) in (?:the )?(?:frame|shot))\b")
        .unwrap()
});
static RE_PROSE_ZH_SOLO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:画面中|镜头里)?(?:只有|仅有)?(?:单人构图|单人入镜|单人镜头)").unwrap());
static RE_APPEARANCE: LazyLock<Regex> = LazyLock::new(|| {
    let adj = "very|extremely|light|dark|bright|pale|deep|long|short|medium|shoulder.length|waist.length|wavy|straight|curly|braided|flowing|silky|fluffy|spiky|tousled|twin|jet|platinum|golden|blond[e]?|black|white|brown|red|pink|blue|silver|purple|orange|green|grey|gray|auburn|violet|lavender|teal|cyan|aqua|turquoise|multicolored|amber|hazel|tan|tanned|fair|olive";
    Regex::new(&format!(
        r"(?i)\b(?:(?:{adj})(?:[, _-]+)){{1,6}}(?:hair|eyes|skin|braids?|ponytails?|pigtails?|bangs)\b|\b(?:blond[e]?|brunette|redheaded|fair.skinned|dark.skinned|(?:{adj})[ _-](?:haired|eyed))\b|\b(?:hime.cut|bob.cut|pigtails?|ponytails?|twintails?|freckles|horns?|halos?|(?:fox|cat|wolf|elf|rabbit|animal|pointed) ears|(?:fluffy|cat|fox|devil) tail|(?:angel|feathered|bat|demon) wings)\b"
    ))
    .unwrap()
});
static RE_CLOTHING_STATES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:(?:(?:fully|completely|entirely|totally)\s+)?(?:nude|naked|unclothed|topless|bottomless|shirtless)|without (?:any )?clothes)\b")
        .unwrap()
});
static RE_COMPOUND_WRAP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:towel|sheet|blanket|robe|cloak|apron|bikini|swimsuit|kimono|silk|lace|leather|lightly|scantily|half|barely)[ -](?:wrapped|clad|draped|dressed)\b")
        .unwrap()
});
static RE_WEARING_CLAUSE: LazyLock<Regex> = LazyLock::new(|| {
    let garment = format!(
        r"(?:(?:a|an|the|her|his|their)\s+)?(?:(?:{GARMENT_MODIFIERS})\s+){{0,6}}(?:{GARMENT_NOUNS})\b",
    );
    Regex::new(&format!(
        r"(?i)\b(?:(?:(?:is|are|was|were)\s+)?(?:wears?|wearing|dressed in|clad in|outfitted in|wrapped in|draped in)|in|has|have|with)\s+(?:{garment})(?:(?:\s*,\s*(?:and\s+)?|\s+(?:and|with|over|under)\s+)(?:{garment}))*",
    ))
    .unwrap()
});
static RE_WEARING_FALLBACK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:(?:is|are|was|were)\s+)?(?:wears?|wearing|dressed in|clad in|outfitted in|wrapped in|draped in)\s+[^.;!?]+")
        .unwrap()
});
static RE_AFTER_CLOTHING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:\s+(?:while|beside|near|next to|in front of|at (?:a|an|the))\s+|",
        r"\s*,\s*(?:holding|standing|sitting|seated|leaning|walking|looking|smiling|laughing|glancing|resting|bracing|raising|reaching|kneeling|lying|turning|turned|wading)\b)",
    ))
    .unwrap()
});
static RE_DANGLING_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:with|who|has|have|is|are|and|or)\s*(,|$)").unwrap());
static RE_BARE_SUBJECT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:the |a |an |another )?(?:(?:left|right|central|center|rear|front|foreground|background|distant|near|far) )*(?:character|subject|person|figure|woman|man|girl|boy)s?|she|he|they|both|each)(?:[.!?;]+|$)")
        .unwrap()
});
static RE_DARK_SKIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:dark|tan|tanned|brown|black|olive|bronze|colored|blue|green|purple|red|gray|grey|orange|yellow|pink)\s+skin(?:ned)?\b|^(?:tan|tanned|dark skinned (?:female|male))$")
        .unwrap()
});
const GARMENT_NOUNS: &str = concat!(
    "uniforms?|(?:sun)?dress(?:es)?|skirts?|overskirts?|shirts?|blouses?|tunics?|sweaters?|cardigans?|blazers?|jackets?|coats?|hoodies?|vests?|",
    "capes?|capelets?|cloaks?|shawls?|ponchos?|kimono|yukata|qipao|cheongsam|sash(?:es)?|obi|habits?|veils?|serafuku|",
    "bikinis?|monokinis?|swimsuits?|swimwear|sarongs?|towels?|leotards?|bodysuits?|bunny suit|",
    "aprons?|pajamas|pyjamas|sleepwear|nightgowns?|nightdress|babydoll|negligee|chemise|rompers?|jumpsuits?|tracksuits?|",
    "lingerie|bras?|panties|underwear|stockings|thighhighs|socks|tights|pantyhose|legwear|garters?|",
    "boots?|shoes?|heels?|sandals?|slippers?|loafers?|hats?|berets?|ribbons?|bowties?|neckties?|",
    "scar(?:f|fs|ves)|gloves?|belts?|suspenders|shorts|pants|trousers|jeans|crop tops?|tank tops?|camisoles?|halter|",
    "sleeves?|collars?|cuffs?|straps?|piping|frills?|ruffles?|chokers?|earrings?|necklaces?|bracelets?|outfits?|costumes?|robes?|suits?|",
    "clothes|clothing|corsets?|bodices?|bustiers?|overalls|headwear|footwear|bottoms|tops|barefoot|bare feet",
);
const GARMENT_MODIFIERS: &str = concat!(
    "a|an|the|and|very|light|dark|bright|deep|pale|warm|soft|white|off-white|black|brown|red|pink|blue|purple|orange|green|",
    "grey|gray|silver|gold|golden|yellow|cream|ivory|navy|beige|burgundy|lavender|teal|striped|polka-dot|checked|plaid|",
    "floral|denim|cotton|wool|woven|knit(?:ted)?|leather|satin|silk|silky|velvet|sheer|lace|lacy|frilled|embroidered|",
    "ruffled|oversized|fitted|tailored|loose|long|short|knee-length|ankle-length|floor-length|sleeveless|long-sleeved|",
    "short-sleeved|pleated|open|buttoned|collared|casual|traditional|school|sailor|maid|wide|high|low|waisted|light-colored|dark-colored|black-and-white|wet|naked|bath",
);
static RE_WARDROBE_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)\b(?:{GARMENT_NOUNS}|maid|sailor)\b")).unwrap());
static RE_REFERENCE_TRAIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:\b(?:hair|bangs|eyebrows?|eyes?|pupils?|skin|complexion|breasts?|chest|cleavage|waist|hips?|stomach|navel|collarbone|thighs?|ass|butt|legs?|feet|toes|face|",
        r"hands?|arms?|shoulders?|armpits?|fingers?|cheeks?|mouth|nose|lips?|lap|nipples?|pussy|penis|nails?|nail polish|fingernails?|blush|sweat|",
        r"freckles|mole|fang|body type|heterochromia|ahoge|twintails?|braids?|ponytails?|ears?|tails?|horns?|wings?|halo|",
        r"slim|petite|muscular|androgynous|male|female|elf|android|kemonomimi|",
        r"girls?|boys?|women|woman|men|man|persons?|people|characters?|subjects?|figures?)\b)"
    ))
    .unwrap()
});

pub(super) fn normalize_key(token: &str) -> String {
    token
        .trim()
        .trim_start_matches(['(', '['])
        .trim_end_matches([')', ']'])
        .to_ascii_lowercase()
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn split_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for segment in text.split("BREAK") {
        for raw in segment.split([',', ';', '\n', '\r']) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_owned());
            }
        }
    }
    out
}

pub(super) fn is_cast_count_tag(token: &str) -> bool {
    let key = normalize_key(token);
    !key.is_empty() && RE_CAST_COUNT.is_match(&key)
}

pub(super) fn is_wardrobe_token(token: &str) -> bool {
    let key = normalize_key(token);
    RE_WARDROBE_WORD.is_match(&key) || RE_CLOTHING_STATES.is_match(&key)
}

pub(super) fn is_reference_appearance_token(token: &str) -> bool {
    RE_REFERENCE_TRAIT.is_match(&normalize_key(token))
}

pub(super) fn conflicts_with_fair_skin(token: &str) -> bool {
    let key = normalize_key(token);
    !key.is_empty() && RE_DARK_SKIN.is_match(&key)
}

pub(super) fn public_tags<S: AsRef<str>>(tokens: &[S]) -> Vec<String> {
    let mut out = Vec::new();
    for raw in tokens {
        for token in split_tokens(raw.as_ref()) {
            let stripped = RE_LORA.replace_all(&token, "");
            let trimmed = stripped.trim();
            if trimmed.is_empty()
                || RE_PRIVATE_CTRL.is_match(trimmed)
                || is_cast_count_tag(trimmed)
            {
                continue;
            }
            out.push(trimmed.to_owned());
        }
    }
    out
}

pub(super) fn unique_tags(tokens: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for token in tokens {
        let key = normalize_key(&token);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(token);
    }
    out
}

pub(super) fn clean_cast_prose(value: &str) -> String {
    let text = RE_LORA.replace_all(value, "");
    let text = RE_PRIVATE_CTRL.replace_all(&text, "");
    let text = text.replace("BREAK", ", ");
    let text = RE_PROSE_ONLY_CHAR.replace_all(&text, "is ");
    let text = RE_PROSE_ONLY_FRAME.replace_all(&text, ",");
    let text = RE_PROSE_NO_OTHER.replace_all(&text, "");
    let text = RE_PROSE_SOLO.replace_all(&text, "");
    let text = RE_PROSE_ZH_SOLO.replace_all(&text, "");
    collapse_punctuation(&text)
}

pub(super) fn clean_cast_negative(value: &str) -> String {
    value
        .split("BREAK")
        .filter_map(|section| {
            let kept: Vec<String> = split_tokens(section)
                .into_iter()
                .filter(|token| {
                    let key = normalize_key(token);
                    !key.is_empty() && !is_cast_count_tag(token) && !RE_NEG_COUNT.is_match(&key)
                })
                .collect();
            if kept.is_empty() {
                None
            } else {
                Some(kept.join(", "))
            }
        })
        .collect::<Vec<_>>()
        .join(" BREAK ")
}

pub(super) fn identity_without_outfit(prose: &str) -> String {
    let cleaned = clean_cast_prose(prose);
    let lower = cleaned.to_ascii_lowercase();
    for marker in [", wearing ", ", dressed in "] {
        if let Some(index) = lower.rfind(marker) {
            let prefix = cleaned[..index].trim_end_matches(|c: char| c.is_whitespace() || c == ',');
            if !prefix.is_empty() {
                return ensure_sentence(prefix);
            }
        }
    }
    cleaned
}

pub(super) fn clean_moss_reference_prose(
    value: &str,
    identity_terms: &[String],
    replace_outfit: bool,
) -> String {
    let mut text = RE_LORA.replace_all(value, "").into_owned();
    text = RE_PRIVATE_CTRL.replace_all(&text, "").into_owned();
    text = text.replace("BREAK", ", ");

    let mut terms: Vec<&str> = identity_terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| term.chars().count() > 1)
        .collect();
    terms.sort_by(|a, b| b.len().cmp(&a.len()));
    let mut seen = HashSet::new();
    let patterns = terms
        .into_iter()
        .filter(|term| seen.insert(term.to_lowercase()))
        .map(|term| term
            .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
            .filter(|part| !part.is_empty())
            .map(regex::escape)
            .collect::<Vec<_>>()
            .join(r"[\s_-]+"))
        .filter(|pattern| !pattern.is_empty())
        .collect::<Vec<_>>()
        .join("|");
    if !patterns.is_empty()
        && let Ok(re) = Regex::new(&format!(r"(?i)(?:^|\b)(?:{patterns})(?:\b|$)"))
    {
        text = re.replace_all(&text, "").into_owned();
    }

    text = RE_APPEARANCE.replace_all(&text, "").into_owned();
    if replace_outfit {
        text = RE_CLOTHING_STATES.replace_all(&text, "").into_owned();
        text = RE_COMPOUND_WRAP.replace_all(&text, "").into_owned();
        text = RE_WEARING_CLAUSE.replace_all(&text, "").into_owned();
        text = RE_WEARING_FALLBACK
            .replace_all(&text, |capture: &regex::Captures<'_>| {
                let clause = &capture[0];
                RE_AFTER_CLOTHING
                    .find(clause)
                    .map(|rest| clause[rest.start()..].to_owned())
                    .unwrap_or_default()
            })
            .into_owned();
    }

    let mut sentences = Vec::new();
    for raw in text.split(['.', '!', '?', ';']) {
        let cleaned = collapse_punctuation(&RE_DANGLING_LINK.replace_all(raw, "$1"));
        if cleaned.is_empty()
            || !cleaned.chars().any(char::is_alphabetic)
            || RE_BARE_SUBJECT.is_match(&cleaned)
        {
            continue;
        }
        sentences.push(ensure_sentence(&cleaned));
    }
    sentences.join(" ")
}

fn collapse_punctuation(text: &str) -> String {
    let mut out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    for (from, to) in [
        (" ,", ","),
        (" .", "."),
        (" !", "!"),
        (" ?", "?"),
        (" ;", ";"),
        (",,", ","),
        (", ,", ","),
        (",.", "."),
        (",!", "!"),
        (",?", "?"),
    ] {
        while out.contains(from) {
            out = out.replace(from, to);
        }
    }
    out.trim_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';'))
        .to_owned()
}

pub(super) fn ensure_sentence(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with(['.', '!', '?', '。', '！', '？']) {
        trimmed.to_owned()
    } else {
        format!("{trimmed}.")
    }
}

pub(super) fn join_sentences(parts: Vec<String>) -> String {
    parts
        .into_iter()
        .map(|part| clean_cast_prose(&part))
        .filter(|part| !part.is_empty())
        .map(|part| ensure_sentence(&part))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn count_tags_by_gender(genders: &[&str]) -> Vec<String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for &gender in genders {
        *counts.entry(gender).or_insert(0) += 1;
    }
    let mut out = Vec::new();
    for gender in ["girl", "boy", "other"] {
        if let Some(&count) = counts.get(gender)
            && count > 0
        {
            if count > 1 {
                out.push(format!("{count}{gender}s"));
            } else {
                out.push(format!("{count}{gender}"));
            }
        }
    }
    out
}
