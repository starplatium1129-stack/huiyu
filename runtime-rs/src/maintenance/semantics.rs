mod records;
mod support;
#[cfg(test)]
mod tests;

use super::{Error, Result, fs, prompt, state};
use serde_json::{Value, json};
use std::path::Path;

pub fn normalize(root: &Path, input: &[Value]) -> Result<Vec<Value>> {
    let pins = fs::json(&root.join("data/prompt-pinned-scenes.json"))?;
    if !pins["scenes"].is_object() {
        return Err(Error::invalid("Invalid pinned scenes"));
    }
    let rated = prompt::classify(input, &pins["scenes"])?;
    if rated.iter().any(|scene| !scene["tags"].is_array()) {
        return Err(Error::invalid("场景 tags 必须为数组"));
    }
    let output = rated
        .iter()
        .map(|scene| prompt::optimize(scene, &pins["scenes"]))
        .collect::<Vec<_>>();
    let errors = optimizer_issues(&output, &pins["scenes"]);
    if !errors.is_empty() {
        let mut error = Error::invalid(errors.join("\n"));
        error.extra = json!({"issues":errors,"stage":"optimize-scenes"}).into();
        return Err(error);
    }
    Ok(output)
}
pub(super) fn optimizer_issues(scenes: &[Value], pins: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for scene in scenes {
        let id = prompt::text(&scene["id"]);
        if !ids.insert(id.clone()) {
            errors.push(format!("{id}: duplicate id"));
        }
        if ["title", "story", "prompt", "negative"]
            .iter()
            .any(|key| !prompt::truthy(&scene[*key]))
        {
            errors.push(format!("{id}: missing required content"));
        }
        if prompt::re!(r"\{[^}]+\}").is_match(&prompt::text(&scene["prompt"])) {
            errors.push(format!("{id}: unresolved prompt placeholder"));
        }
        let tags = prompt::strings(&scene["tags"]);
        if scene["char"] == "triad" && !tags.iter().any(|tag| tag == "2girls") {
            errors.push(format!("{id}: dual scene missing 2girls"));
        }
        if scene["char"] != "triad" && tags.iter().any(|tag| tag == "2girls") {
            errors.push(format!("{id}: solo scene contains 2girls"));
        }
        let effective = prompt::effective(scene);
        let pinned = prompt::truthy(&pins[&id]);
        if !pinned {
            let nsfw =
                prompt::re!(r"(^|, )nsfw(,|$)").is_match(&prompt::text(&effective["negative"]));
            if scene["rating"] == "All" && !nsfw {
                errors.push(format!("{id}: All scene lacks nsfw exclusion"));
            }
            if scene["rating"] == "R15" && nsfw {
                errors.push(format!(
                    "{id}: R15 negative blocks the intended suggestive rating"
                ));
            }
        }
        errors.extend(
            prompt::issues(&effective, pinned)
                .into_iter()
                .map(|issue| format!("{id}: {issue}")),
        );
    }
    errors
}
pub fn validate(root: &Path, scenes: &[Value]) -> Vec<String> {
    let mut errors = Vec::new();
    let mut read = |name: &str| match fs::json(&root.join("data").join(name)) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("{name} cannot be parsed: {}", error.message));
            json!([])
        }
    };
    let characters = read("characters.json");
    let presets = read("presets.json");
    let curation = read("curation.json");
    let retired = read("retired-scenes.json");
    let pins = read("prompt-pinned-scenes.json");
    let mut loras = std::collections::HashMap::new();
    if let Some(characters) = characters.as_array() {
        for character in characters {
            if let Some(id @ ("nene" | "natsume")) = character["id"].as_str()
                && prompt::truthy(&character["lora"]["name"])
            {
                loras.insert(id, prompt::text(&character["lora"]["name"]));
            }
        }
    }
    if !loras.contains_key("nene") || !loras.contains_key("natsume") {
        errors.push("characters.json must define current Nene and Natsume LoRA names".into());
    }
    records::validate(scenes, &pins["scenes"], &loras, &mut errors);
    support::validate(
        scenes,
        &characters,
        &presets,
        &curation,
        &retired,
        &mut errors,
    );
    errors
}
pub fn inspect(root: &Path, scenes: &[Value]) -> Result<Value> {
    let errors = validate(root, scenes);
    Ok(
        json!({"ok":errors.is_empty(),"stage":"validate-scenes","errors":errors,"visualReview":"unverified"}),
    )
}
