mod dialects;
mod input;

use super::*;
use regex::Regex;
use std::sync::LazyLock;

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

pub(super) fn compile(
    body: &Value,
    model: &Value,
    input_mode: &str,
    duration: u64,
) -> Result<Compiled> {
    if !["text", "image", "first-last-frame"].contains(&input_mode)
        || !input::supports_mode(model, input_mode)
    {
        return Err(error(400, "MODEL_INPUT_MODE", "所选模型不支持当前创作方式"));
    }
    let mode = match model["drivingInput"].as_str() {
        Some("video") => "motion-driver",
        Some("audio") => "voice-driver",
        _ => input_mode,
    };
    let driven = mode.ends_with("-driver");
    let recipe_parsed = input::parse_recipe(body, mode)?;
    let user = validation::prompt_text(body, true)?;
    let negative = validation::negative_text(body)?;
    let parts = input::read_description(user);
    let audio_supported = supports_audio(model);
    let family = model["family"].as_str().unwrap_or("");
    let h3 = family == "minimax-h3";
    let ltx = matches!(family, "ltx" | "ltx-2.3" | "ltx-2.5");
    let kandinsky = family == "kandinsky-6";
    let english = h3 || ltx || kandinsky;
    let locale = if english { "en" } else { "zh" };
    let description = parts.visual.join(if english { " " } else { "\n" });
    let description = if !audio_supported {
        input::visual_only(&description)
    } else {
        description
    };
    let description = if family.starts_with("hunyuan") {
        description.replace(['“', '”', '「', '」'], "\"")
    } else {
        description
    };
    let [framing, subject, action, camera, atmosphere, ending] = recipe_parsed
        .slots
        .map(|item| item.map(|value| input::phrase(value, locale)).unwrap_or_default());
    let frame_direction = input_mode != "text" && (!camera.is_empty() || !ending.is_empty());
    if !frame_direction
        && [subject, action, atmosphere, &description]
            .iter()
            .all(|value| value.is_empty())
    {
        return Err(invalid("请填写镜头描述，或选择适用于当前创作方式的积木"));
    }
    let direction = input::QUOTED_TEXT.replace_all(&description, "");
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
        input::phrase(
            &input::LIBRARY["slots"]["camera"]["options"]
                [body["camera"].as_str().unwrap_or("still")],
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
        input::phrase(&input::LIBRARY["slots"]["ending"]["options"]["match-last"], locale)
    } else {
        ending
    };
    let sound = recipe_parsed
        .sound
        .map(|s| input::phrase(s, "en"))
        .map(str::to_owned)
        .unwrap_or_else(|| parts.sound.join(" "));
    let sound = if sound.is_empty() {
        "Natural ambience follows the setting and the visible movement."
    } else {
        &sound
    };
    let score = recipe_parsed
        .music
        .map(|m| input::phrase(m, "en"))
        .map(str::to_owned)
        .unwrap_or_else(|| parts.music.join(" "));
    let spoken = if recipe_parsed.spoken.is_empty() {
        parts.dialogue.join("\n")
    } else {
        recipe_parsed.spoken.to_owned()
    };
    let name = prose::language(&spoken, recipe_parsed.spoken_language);
    let dialogue = if spoken.is_empty() || !(h3 || ltx) {
        String::new()
    } else if h3 {
        format!("The subject (S1) says: <d>[{name}] {spoken}</d>")
    } else {
        format!("The subject says in {name}, \"{spoken}\".")
    };
    let description = dialects::sentence(&description, english);
    let prompt = dialects::format_prompt(dialects::PromptParts {
        anchor,
        framing,
        subject,
        description: &description,
        action,
        fallback_motion,
        camera,
        atmosphere,
        ending,
        sound,
        score: &score,
        dialogue: &dialogue,
        input_mode,
        duration,
        h3,
        ltx,
        kandinsky,
        english,
    });
    let subtle_slot =
        !action.is_empty() && recipe_parsed.slots[2].is_some_and(|option| option["motion"] == "subtle");
    let quiet = (body["motion"] == "subtle" && action.is_empty() && !user_motion)
        || subtle_slot
        || (!user_camera && recipe_parsed.camera_is_still)
        || [subject_direction.as_ref(), action, ending]
            .iter()
            .any(|line| QUIET_MOTION.is_match(line));
    let visible_text = input::QUOTED_TEXT.is_match(&description) || description.contains("字幕");
    let original = if user.is_empty() {
        recipe_parsed
            .slots
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
        negative: dialects::negative_prompt(model, negative, quiet, visible_text),
    })
}
