use super::*;
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
static LIBRARY: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("prompt-library.json"))
        .expect("built-in video prompt library")
});
static CAMERA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?ix)
        (?:固定|锁定)(?:机位|镜头)|稳机位|镜头不动|
        (?:镜头|机位)[^。！？；，,]{0,10}?(?:推进|推近|拉近|拉远|横移|平移|环绕|摇摄|摇移|跟拍|跟随|变焦|静止|固定|后退|保持稳定|仰起|俯落|缓摇)|
        (?:缓慢|极缓|小幅|平稳)(?:推进|推近|拉远|横移|平移|环绕|变焦|仰起|俯落|跟拍)|缓推|缓移|缓摇|仰拍|手持|
        \b(?:locked[- ]off|(?:static|fixed)\s+(?:shot|camera)|tracking\s+shot|camera\s+orbit|handheld)\b|
        \b(?:camera|shot)\s+(?:(?:slowly|steadily|gently|gradually|slightly|then)\s+)*(?:holds|stays|remains\s+(?:still|steady|fixed)|pushes|pulls|dollies|tracks|pans|arcs|orbits|tilts|zooms|follows|moves|glides)\b|
        \b(?:dolly|zoom|pan|tilt|truck|push|pull)\s+(?:in|out|back|left|right|up|down)\b|
        \btilt(?:s|ed|ing)?\s+(?:up(?:ward)?|down(?:ward)?)\b
    ").unwrap()
});
static QUIET_MOTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)微动|细微|眨眼|轻轻眨|呼吸|定格|一动不动|\b(?:micro[- ]?motion|subtle motion|blink\w*|breath\w*|motionless|freeze frame)\b").unwrap()
});
static QUOTED_TEXT: LazyLock<Regex> =
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

pub(super) struct Compiled {
    pub prompt: String,
    pub original: String,
    pub negative: Option<String>,
}

pub(super) fn supports_negative(model: &Value) -> bool {
    model["negative"]
        .as_bool()
        .unwrap_or(model["family"] != "minimax-h3")
}

pub(super) fn supports_audio(model: &Value) -> bool {
    model["drivingInput"].is_null()
        && model["audio"].as_bool().unwrap_or(matches!(
            model["family"].as_str(),
            Some("minimax-h3" | "ltx")
        ))
}

pub(super) fn input_mode(body: &Value) -> Result<&'static str> {
    match (
        validation::present(&body["image"]),
        validation::present(&body["lastFrame"]),
    ) {
        (true, true) => Ok("first-last-frame"),
        (true, false) => Ok("image"),
        (false, false) => Ok("text"),
        (false, true) => Err(invalid("首尾帧过渡需要同时指定首帧和尾帧")),
    }
}

fn invalid(message: &str) -> ApiError {
    error(400, "INVALID_VIDEO_PROMPT", message)
}

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
struct Description<'a> {
    visual: Vec<&'a str>,
    sound: Vec<&'a str>,
    music: Vec<&'a str>,
    dialogue: Vec<&'a str>,
}

fn read_description(user: &str) -> Description<'_> {
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

fn supports_mode(option: &Value, mode: &str) -> bool {
    option["modes"]
        .as_array()
        .is_none_or(|modes| modes.iter().any(|m| m == mode))
}

fn selected_option<'a>(options: &'a Value, id: &str) -> Result<&'a Value> {
    options
        .get(id)
        .ok_or_else(|| invalid("所选积木已无法识别，请重新选择"))
}

fn phrase<'a>(value: &'a Value, language: &str) -> &'a str {
    value[language].as_str().unwrap_or_default()
}

fn sentence(text: &str, english: bool) -> String {
    let text = text.trim();
    if text.is_empty() || text.ends_with(['.', '!', '?', '。', '！', '？', '…']) {
        text.to_owned()
    } else {
        format!("{text}{}", if english { "." } else { "。" })
    }
}

fn visual_only(text: &str) -> String {
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

fn negative_prompt(model: &Value, requested: &str, quiet: bool, text: bool) -> Option<String> {
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

pub(super) fn compile(
    body: &Value,
    model: &Value,
    input_mode: &str,
    duration: u64,
) -> Result<Compiled> {
    if !["text", "image", "first-last-frame"].contains(&input_mode)
        || !supports_mode(model, input_mode)
    {
        return Err(error(400, "MODEL_INPUT_MODE", "所选模型不支持当前创作方式"));
    }
    let mode = match model["drivingInput"].as_str() {
        Some("video") => "motion-driver",
        Some("audio") => "voice-driver",
        _ => input_mode,
    };
    let driven = mode.ends_with("-driver");
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
    let user = validation::prompt_text(body, true)?;
    let negative = validation::negative_text(body)?;
    let parts = read_description(user);
    let audio_supported = supports_audio(model);
    let family = model["family"].as_str().unwrap_or("");
    let h3 = family == "minimax-h3";
    let ltx = matches!(family, "ltx" | "ltx-2.3" | "ltx-2.5");
    let kandinsky = family == "kandinsky-6";
    let english = h3 || ltx || kandinsky;
    let locale = if english { "en" } else { "zh" };
    let description = parts.visual.join(if english { " " } else { "\n" });
    let description = if !audio_supported {
        visual_only(&description)
    } else {
        description
    };
    let description = if family.starts_with("hunyuan") {
        description.replace(['“', '”', '「', '」'], "\"")
    } else {
        description
    };
    let [framing, subject, action, camera, atmosphere, ending] =
        slots.map(|item| item.map(|value| phrase(value, locale)).unwrap_or_default());
    let frame_direction = input_mode != "text" && (!camera.is_empty() || !ending.is_empty());
    if !frame_direction
        && [subject, action, atmosphere, &description]
            .iter()
            .all(|value| value.is_empty())
    {
        return Err(invalid("请填写镜头描述，或选择适用于当前创作方式的积木"));
    }
    let direction = QUOTED_TEXT.replace_all(&description, "");
    let user_camera = CAMERA.is_match(&direction);
    let subject_direction = CAMERA.replace_all(&direction, "");
    let user_motion = !driven
        && (prose::mentions_motion(&subject_direction)
            || QUIET_MOTION.is_match(&subject_direction));
    let action = if user_motion { "" } else { action };
    let camera = if driven {
        match (mode == "voice-driver", english) {
            (true, true) => "The camera stays steady while lip-sync follows the supplied audio.",
            (true, false) => "镜头保持稳定，口型跟随所给配音。",
            (false, true) => "The camera stays steady while body motion follows the driving video.",
            (false, false) => "镜头保持稳定，动作跟随参考视频。",
        }
    } else if user_camera {
        ""
    } else if !camera.is_empty() {
        camera
    } else if input_mode == "first-last-frame" && body["camera"] == "still" {
        "" // Let the two frames determine framing when no motion is selected.
    } else {
        phrase(
            &LIBRARY["slots"]["camera"]["options"][body["camera"].as_str().unwrap_or("still")],
            locale,
        )
    };
    let fallback_motion =
        if !driven && input_mode != "first-last-frame" && !user_motion && action.is_empty() {
            let motion = body["motion"].as_str().unwrap_or("subtle");
            if motion == "subtle" {
                if english {
                    "The frame stays alive with small, continuous movement."
                } else {
                    "画面保留自然、连贯的细微运动。"
                }
            } else {
                prose::table()[if english { "H3_MOTION" } else { "MOTION" }][motion]
                    .as_str()
                    .unwrap_or("")
            }
        } else {
            ""
        };
    let anchor = match (input_mode, driven, h3, english) {
        ("image", false, true, _) => {
            "The shot develops from <Picture 1>, preserving its subject and composition."
        }
        ("first-last-frame", false, true, _) => {
            "The shot begins with the composition and pose established by Picture 1."
        }
        ("image", false, false, true) => "The shot continues from the opening frame.",
        ("image", false, false, false) => "从首帧的姿态和构图开始，保留主体与场景的空间关系。",
        ("first-last-frame", false, false, true) => {
            "The shot transitions continuously from the opening frame's pose and composition."
        }
        ("first-last-frame", false, false, false) => "从首帧的姿态和构图开始连续过渡。",
        _ => "",
    };
    let ending = if input_mode == "first-last-frame" && ending.is_empty() {
        phrase(&LIBRARY["slots"]["ending"]["options"]["match-last"], locale)
    } else {
        ending
    };
    let sound = sound
        .map(|s| phrase(s, "en"))
        .map(str::to_owned)
        .unwrap_or_else(|| parts.sound.join(" "));
    let sound = if sound.is_empty() {
        "Natural ambience follows the setting and the visible movement."
    } else {
        &sound
    };
    let score = music
        .map(|m| phrase(m, "en"))
        .map(str::to_owned)
        .unwrap_or_else(|| parts.music.join(" "));
    let spoken = if spoken.is_empty() {
        parts.dialogue.join("\n")
    } else {
        spoken.to_owned()
    };
    let name = prose::language(&spoken, spoken_language);
    let dialogue = if spoken.is_empty() || !(h3 || ltx) {
        String::new()
    } else if h3 {
        format!("The subject (S1) says: <d>[{name}] {spoken}</d>")
    } else {
        format!("The subject says in {name}, \"{spoken}\".")
    };
    let description = sentence(&description, english);
    let visual = [
        anchor,
        framing,
        subject,
        &description,
        action,
        fallback_motion,
        camera,
        atmosphere,
        ending,
    ];
    let prompt = if kandinsky {
        let opening = kandinsky_sentence(&[anchor, framing, subject]);
        let motion = kandinsky_sentence(&[action, fallback_motion, camera, atmosphere]);
        let finish = kandinsky_sentence(&[ending, sound]);
        join(&[&opening, &description, &motion, &finish], " ")
    } else if h3 {
        let visual = join(&[&join(&visual, " "), &dialogue], " ");
        let score = if score.is_empty() { "N/A" } else { &score };
        let content = format!(
            "integrated_multimodal_description: [Shot 1] {visual}\n\noverall_soundscape: {sound}\n\nnon_diegetic_music: {score}"
        );
        match prose::h3_alignment(
            input_mode != "text",
            input_mode == "first-last-frame",
            duration,
        ) {
            Some(alignment) => format!("{alignment}\n\n{content}"),
            None => content,
        }
    } else if ltx {
        let score = if score.eq_ignore_ascii_case("N/A") {
            "The scene plays without background music."
        } else {
            &score
        };
        join(
            &[
                &join(&visual, " "),
                &sentence(sound, true),
                &dialogue,
                &sentence(score, true),
            ],
            " ",
        )
    } else if english {
        join(&visual, " ")
    } else {
        join_zh(&visual)
    };
    let subtle_slot = !action.is_empty() && slots[2].is_some_and(|option| option["motion"] == "subtle");
    let quiet = (body["motion"] == "subtle" && action.is_empty() && !user_motion)
        || subtle_slot
        || (!user_camera && recipe.get("camera").and_then(Value::as_str) == Some("still"))
        || [subject_direction.as_ref(), action, ending]
            .iter()
            .any(|line| QUIET_MOTION.is_match(line));
    let visible_text = QUOTED_TEXT.is_match(&description) || description.contains("字幕");
    let original = if user.is_empty() {
        slots
            .iter()
            .flatten()
            .filter_map(|item| item["zh"].as_str())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        user.to_owned()
    };
    Ok(Compiled {
        prompt,
        original,
        negative: negative_prompt(model, negative, quiet, visible_text),
    })
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
