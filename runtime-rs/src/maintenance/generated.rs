use super::{Error, Result, prompt, state};
use serde_json::{Value, json};

fn fail() -> Error {
    Error::invalid("生成场景配方无效或与场景内容不一致")
}
fn string(value: &Value, max: usize, empty: bool) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() <= max && (empty || !s.trim().is_empty()) && !s.contains('\0'))
}
fn number(value: &Value, min: f64, max: f64, integer: bool) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= min && n <= max && (!integer || n.fract() == 0.0))
}
fn numeric(value: &Value, min: f64, max: f64, integer: bool) -> bool {
    if let Some(s) = value.as_str() {
        return s
            .parse::<f64>()
            .is_ok_and(|n| number(&json!(n), min, max, integer));
    }
    number(value, min, max, integer)
}
fn size(value: &Value) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    let parts: Vec<_> = s.split(['x', '×']).collect();
    parts.len() == 2
        && parts.iter().all(|s| {
            s.parse::<u32>()
                .is_ok_and(|n| (512..=4096).contains(&n) && n % 8 == 0)
        })
}
fn parameters(value: &Value) -> bool {
    let Some(values) = value.as_object() else {
        return false;
    };
    values.iter().all(|(key, v)| match key.as_str() {
        "seed" => number(v, -1.0, 9007199254740991.0, true),
        "steps" | "hiresSteps" => numeric(v, 0.0, 200.0, true),
        "cfg" => numeric(v, 0.0, 50.0, false),
        "width" | "height" => {
            number(v, 512.0, 4096.0, true) && v.as_u64().is_some_and(|n| n % 8 == 0)
        }
        "hiresScale" => number(v, 1.0, 4.0, false),
        "hiresDenoise" => number(v, 0.0, 1.0, false),
        "loraStrength" => v.is_null() || number(v, -4.0, 4.0, false),
        "hiresFix" | "faceDetailer" | "noLora" | "preview" => v.is_boolean(),
        "size" => size(v),
        "provider" => matches!(v.as_str(), Some("comfy" | "webui")),
        "lora" | "loraId" | "styleLoraId" => v.is_null() || string(v, 512, true),
        "model" | "profile" | "checkpoint" | "sampler" | "scheduler" | "hiresUpscaler"
        | "outfitId" | "character" | "characterId" | "blueprintId" | "subject" | "scene"
        | "sceneTitle" | "shot" | "lighting" | "composition" | "colorMood" => {
            v.is_null() || string(v, 512, true)
        }
        "story" | "visualDescription" => v.is_null() || string(v, 16000, true),
        "artistStyleIds" | "emotion" | "manual_tags" => v
            .as_array()
            .is_some_and(|a| a.len() <= 256 && a.iter().all(|s| string(s, 128, false))),
        "loras" => v.as_array().is_some_and(|a| {
            a.len() <= 16
                && a.iter().all(|l| {
                    l.as_object().is_some_and(|o| o.len() == 2)
                        && string(&l["id"], 512, false)
                        && number(&l["strength"], -4.0, 4.0, false)
                })
        }),
        _ => false,
    })
}
/// Captured prompts bypass editorial normalization only after their full contract is checked.
/// They must remain byte-identical to the recipe used for an already generated image.
pub(super) fn validate(scene: &Value, blueprint: bool) -> Result<bool> {
    let Some(recipe) = scene.get("generatedRecipe") else {
        return Ok(false);
    };
    if !recipe.as_object().is_some_and(|o| o.len() == 5)
        || recipe["version"] != 1
        || !matches!(recipe["engine"].as_str(), Some("sd" | "anima" | "krea2"))
        || !string(&recipe["prompt"], 64000, false)
        || !string(&recipe["negative"], 32000, true)
        || (recipe["engine"] == "krea2" && recipe["negative"] != "")
        || !parameters(&recipe["parameters"])
        || !string(&scene["title"], 512, false)
        || !string(
            &scene[if blueprint { "description" } else { "story" }],
            16000,
            false,
        )
        || !size(&scene["recommendedSize"])
    {
        return Err(fail());
    }
    if blueprint {
        if !string(&scene["id"], 160, false)
            || !string(&scene["characterId"], 160, false)
            || !scene["adult"].is_boolean()
            || !string(&scene["outfitId"], 160, false)
            || !scene["sceneTags"]
                .as_array()
                .is_some_and(|a| a.len() <= 256 && a.iter().all(|s| string(s, 512, false)))
            || !matches!(
                scene["compositionIntent"].as_str(),
                Some("single" | "group" | "triptych")
            )
            || (recipe["engine"] == "krea2"
                && (scene["promptProse"] != recipe["prompt"] || scene["promptTokens"] != json!([])))
            || (recipe["engine"] != "krea2"
                && (scene["promptTokens"] != json!([recipe["prompt"]])
                    || scene["promptProse"] != ""))
            || scene["negativeTokens"]
                != if recipe["negative"] == "" {
                    json!([])
                } else {
                    json!([recipe["negative"]])
                }
        {
            return Err(fail());
        }
        let classified = prompt::rating(
            &json!({"title":scene["title"],"story":format!("{} {}", scene["description"].as_str().unwrap_or(""), recipe["prompt"].as_str().unwrap()),"prompt":recipe["prompt"],"tags":scene["sceneTags"]}),
        );
        if !matches!(scene["sampleRating"].as_str(), Some("All" | "R15" | "R18"))
            || scene["adult"] != json!(scene["sampleRating"] == "R18")
            || (classified == "R18" && scene["adult"] != true)
            || (classified == "R15" && scene["sampleRating"] == "All")
        {
            return Err(fail());
        }
    } else {
        let character = scene["char"].as_str().unwrap_or("");
        let expected = match character {
            "nene" => json!(["nene"]),
            "natsume" => json!(["natsume"]),
            "triad" => json!(["nene", "natsume"]),
            _ => return Err(fail()),
        };
        if state::scene_number(scene["id"].as_str().unwrap_or("")).is_none()
            || scene["character"] != expected
            || !matches!(scene["rating"].as_str(), Some("All" | "R15" | "R18"))
            || scene["mature"] != json!(scene["rating"] == "R18")
            || scene["prompt"] != recipe["prompt"]
            || scene["negative"] != recipe["negative"]
            || !scene["tags"]
                .as_array()
                .is_some_and(|a| a.len() <= 256 && a.iter().all(|s| string(s, 512, false)))
            || !scene["usage"]
                .as_array()
                .is_some_and(|a| a.len() <= 256 && a.iter().all(|s| string(s, 512, false)))
            || !string(&scene["category"], 512, false)
        {
            return Err(fail());
        }
    }
    Ok(true)
}
pub(super) fn valid(scene: &Value) -> bool {
    matches!(validate(scene, false), Ok(true))
}
pub(super) fn rating(scene: &Value) -> &'static str {
    let mut source = scene.clone();
    source["story"] = format!(
        "{} {}",
        prompt::text(&scene["story"]),
        prompt::text(&scene["prompt"])
    )
    .into();
    let inferred = prompt::rating(&source);
    if scene["rating"] == "R18" || inferred == "R18" {
        "R18"
    } else if scene["rating"] == "R15" || inferred == "R15" {
        "R15"
    } else {
        "All"
    }
}
