use super::invalid;
use super::super::*;
use regex::Regex;
use serde::Deserialize;
use std::sync::LazyLock;

const VISUAL_SLOTS: [&str; 6] = [
    "framing",
    "subject",
    "action",
    "camera",
    "atmosphere",
    "ending",
];

pub(super) static LIBRARY: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../prompt-library.json"))
        .expect("built-in video prompt library")
});

pub(super) static QUOTED_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""[^"]*"|“[^”]*”|「[^」]*」"#).unwrap());

static AUDIO_CLAUSE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?ix)[，,]\s*(?:
        (?:可以|还能|可|能)?听(?:见|到|得见)|
        (?:伴随着?|伴有)[^。！？.!?，,]*?(?:声响|声音|雨声|风声|水声|蝉鸣|风铃声|脚步声|音乐|配乐|音效)|
        (?:you|we)\s+(?:can\s+)?hear\b|
        (?:with|accompanied\s+by)\s+(?:the\s+)?(?:sound|music|background\s+music|ambient\s+sound|footsteps|(?:soft\s+)?piano)\b
    )[^。！？.!?，,]*").unwrap()
});

static AUDIO_SENTENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:只听见|可以听见|能听见|可听见|还能听见|听得到|听得见|(?:you|we) (?:can )?hear\b|(?:低声|轻柔|缓慢|没有|无)?(?:背景音乐|配乐|声景|环境音|音效|雨声|风声|脚步声)|(?:soft |faint |quiet |steady )?(?:footsteps|background music|ambient sound|room tone|sound effects|soundtrack)\b)").unwrap()
});

#[derive(Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Audio<'a> {
    sound: Option<&'a str>,
    music: Option<&'a str>,
    dialogue: Option<&'a str>,
    language: Option<&'a str>,
}

#[derive(Clone, Copy)]
enum Section {
    Visual,
    Sound,
    Music,
    Dialogue,
}

#[derive(Default)]
pub(super) struct Description<'a> {
    pub visual: Vec<&'a str>,
    pub sound: Vec<&'a str>,
    pub music: Vec<&'a str>,
    pub dialogue: Vec<&'a str>,
}

pub(super) struct ParsedRecipe<'a> {
    pub slots: [Option<&'static Value>; VISUAL_SLOTS.len()],
    pub sound: Option<&'static Value>,
    pub music: Option<&'static Value>,
    pub spoken: &'a str,
    pub spoken_language: &'a str,
    pub camera_is_still: bool,
}

pub(super) fn parse_recipe<'a>(body: &'a Value, mode: &str) -> Result<ParsedRecipe<'a>> {
    let recipe = body["promptRecipe"]
        .as_object()
        .ok_or_else(|| invalid("积木设置格式无效"))?;
    let mut slots = [None; VISUAL_SLOTS.len()];
    for (key, value) in recipe.iter().filter(|(key, _)| *key != "audio") {
        let index = VISUAL_SLOTS
            .iter()
            .position(|slot| *slot == key.as_str())
            .ok_or_else(|| invalid("积木槽位无法识别"))?;
        let group = &LIBRARY["slots"][key.as_str()];
        let id = value
            .as_str()
            .ok_or_else(|| invalid("每个积木槽位只能选择一项"))?;
        let option = selected_option(&group["options"], id)?;
        if supports_mode(group, mode) && supports_mode(option, mode) {
            slots[index] = Some(option);
        }
    }
    let audio = recipe
        .get("audio")
        .map(Audio::deserialize)
        .transpose()
        .map_err(|_| invalid("声景设置格式无效"))?
        .unwrap_or_default();
    let sound = audio
        .sound
        .map(|id| selected_option(&LIBRARY["sounds"], id))
        .transpose()?;
    let music = audio
        .music
        .map(|id| selected_option(&LIBRARY["music"], id))
        .transpose()?;
    let spoken = audio.dialogue.unwrap_or("").trim();
    let spoken_language = audio.language.unwrap_or("auto");
    if spoken.encode_utf16().count() > 300 || !["auto", "en", "zh", "ja"].contains(&spoken_language)
    {
        return Err(invalid(
            "对白需为不超过 300 字符的文本，语言支持中文、英文或日文",
        ));
    }
    let camera_is_still = recipe.get("camera").and_then(Value::as_str) == Some("still");
    Ok(ParsedRecipe {
        slots,
        sound,
        music,
        spoken,
        spoken_language,
        camera_is_still,
    })
}

pub(super) fn read_description(user: &str) -> Description<'_> {
    let mut parts = Description::default();
    let mut section = Section::Visual;
    for line in user.lines().map(str::trim) {
        if line.is_empty() {
            section = Section::Visual;
            continue;
        }
        let line = if let Some((key, value)) = line.split_once([':', '：']) {
            let next = match key.trim().to_ascii_lowercase().as_str() {
                "integrated_multimodal_description" => Some(Section::Visual),
                "overall_soundscape" | "soundscape" | "audio" | "声景" | "环境声" | "音效" => {
                    Some(Section::Sound)
                }
                "non_diegetic_music" | "music" | "配乐" | "背景音乐" => Some(Section::Music),
                "dialogue" | "对白" => Some(Section::Dialogue),
                _ => None,
            };
            if let Some(next) = next {
                section = next;
                value.trim()
            } else {
                line
            }
        } else {
            line
        };
        if line.starts_with("For the target video, at 0.00 seconds")
            || line.starts_with("How the reference pictures align with the target video")
        {
            continue;
        }
        let (target, content) = match section {
            Section::Visual => (
                &mut parts.visual,
                line.strip_prefix("[Shot 1]").unwrap_or(line).trim(),
            ),
            Section::Sound => (&mut parts.sound, line),
            Section::Music => (&mut parts.music, line),
            Section::Dialogue => (&mut parts.dialogue, line),
        };
        if !content.is_empty() {
            target.push(content);
        }
    }
    parts
}

pub(super) fn supports_mode(option: &Value, mode: &str) -> bool {
    option["modes"]
        .as_array()
        .is_none_or(|modes| modes.iter().any(|m| m == mode))
}

fn selected_option<'a>(options: &'a Value, id: &str) -> Result<&'a Value> {
    options
        .get(id)
        .ok_or_else(|| invalid("所选积木已无法识别，请重新选择"))
}

pub(super) fn phrase<'a>(value: &'a Value, language: &str) -> &'a str {
    value[language].as_str().unwrap_or_default()
}

pub(super) fn visual_only(text: &str) -> String {
    // Keep visible text verbatim while removing clearly marked audio clauses.
    fn append_visual(output: &mut String, text: &str) {
        for part in text.split_inclusive(['。', '！', '？', '.', '!', '?', '\n']) {
            let visible = if AUDIO_SENTENCE.is_match(part) {
                part.split_once(['，', ',']).map_or("", |(_, rest)| rest)
            } else {
                part
            };
            output.push_str(&AUDIO_CLAUSE.replace_all(visible, ""));
        }
    }
    let mut output = String::with_capacity(text.len());
    let mut start = 0;
    for quoted in QUOTED_TEXT.find_iter(text) {
        append_visual(&mut output, &text[start..quoted.start()]);
        output.push_str(quoted.as_str());
        start = quoted.end();
    }
    append_visual(&mut output, &text[start..]);
    output.trim().to_owned()
}
