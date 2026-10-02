use super::*;
use std::collections::{BTreeSet, HashSet};

fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn string(value: &Value) -> String {
    prompt::text(value)
}
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(u8::from(*value) as f64),
        Value::String(value) if prompt::trim(value).is_empty() => Some(0.0),
        Value::String(value) => prompt::trim(value).parse::<f64>().ok(),
        Value::Number(value) => value.as_f64(),
        _ => None,
    }
    .filter(|value| value.is_finite())
}
fn searchable(scene: &Value) -> String {
    [
        "id",
        "title",
        "story",
        "emotion",
        "char",
        "category",
        "season",
        "timeOfDay",
        "location",
        "weather",
        "camera",
        "lighting",
    ]
    .iter()
    .map(|key| string(&scene[*key]))
    .chain(list(&scene["tags"]).iter().map(string))
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
}
pub(super) fn validate(
    scenes: &[Value],
    characters: &Value,
    presets: &Value,
    curation: &Value,
    retired: &Value,
    errors: &mut Vec<String>,
) {
    let ids = scenes
        .iter()
        .map(|scene| string(&scene["id"]))
        .collect::<HashSet<_>>();
    let mut retired_ids = HashSet::new();
    for record in list(&retired["records"]) {
        let id = string(&record["id"]);
        if state::scene_number(&id).is_none() {
            errors.push("retired-scenes.json contains an invalid id".into());
            continue;
        }
        if !retired_ids.insert(id.clone()) {
            errors.push(format!("retired-scenes.json duplicate id {id}"));
        }
        if ids.contains(&id) {
            errors.push(format!("retired scene is still active: {id}"));
        }
        if !prompt::truthy(&record["reason"]) {
            errors.push(format!("retired scene lacks reason: {id}"));
        }
    }
    let numbers = ids
        .iter()
        .chain(retired_ids.iter())
        .filter_map(|id| state::scene_number(id))
        .collect::<BTreeSet<_>>();
    let mut expected = 1;
    for number in numbers {
        if number > expected {
            let count = number - expected;
            if count <= 20 {
                for number in expected..number {
                    errors.push(format!("missing undeclared id sc{number:03}"));
                }
            } else {
                errors.push(format!(
                    "missing undeclared ids sc{expected:03}..sc{:03} ({count})",
                    number - 1
                ));
            }
        }
        expected = number + 1;
    }
    let curated = list(&curation["curatedSceneIds"]);
    let signature = list(&curation["signatureSceneIds"]);
    let review = list(&curation["reviewSceneIds"]);
    let reasons = &curation["recommendationReasons"];
    let rails = list(&curation["moodRails"]);
    if curated.is_empty() {
        errors.push("curation.json must define curatedSceneIds".into());
    }
    if signature.is_empty() {
        errors.push("curation.json must define signatureSceneIds".into());
    }
    if rails.is_empty() {
        errors.push("curation.json must define moodRails".into());
    }
    let mut seen = HashSet::new();
    for id in curated {
        let id = string(id);
        if !seen.insert(id.clone()) {
            errors.push(format!("curation.json duplicate curated scene: {id}"));
        }
        if !ids.contains(&id) {
            errors.push(format!("curation.json references missing scene: {id}"));
        }
    }
    for id in signature {
        let id = string(id);
        if !ids.contains(&id) {
            errors.push(format!(
                "curation.json signature references missing scene: {id}"
            ));
        }
        if !seen.contains(&id) {
            errors.push(format!(
                "curation.json signature must also be curated: {id}"
            ));
        }
        if prompt::trim(&string(&reasons[&id])).is_empty() {
            errors.push(format!(
                "curation.json signature needs a recommendation reason: {id}"
            ));
        }
    }
    for id in review {
        let id = string(id);
        if !ids.contains(&id) {
            errors.push(format!(
                "curation.json review references missing scene: {id}"
            ));
        }
        if seen.contains(&id) {
            errors.push(format!(
                "curation.json scene cannot be both curated and review: {id}"
            ));
        }
    }
    if let Some(core) = curation.get("personaCoreSceneIds") {
        if let Some(core) = core.as_array() {
            let mut seen = HashSet::new();
            for (index, id) in core.iter().enumerate() {
                let Some(id) = id.as_str().filter(|id| !prompt::trim(id).is_empty()) else {
                    errors.push(format!(
                        "curation.json personaCoreSceneIds[{index}] must be a non-empty string"
                    ));
                    continue;
                };
                if !seen.insert(id) {
                    errors.push(format!("curation.json personaCoreSceneIds[{index}] duplicates an earlier entry: {id}"));
                }
                if !ids.contains(id) {
                    errors.push(format!(
                        "curation.json personaCoreSceneIds[{index}] references missing scene: {id}"
                    ));
                }
            }
        } else {
            errors.push("curation.json personaCoreSceneIds must be an array".into());
        }
    }
    if let Some(reasons) = reasons.as_object() {
        for id in reasons.keys() {
            if !ids.contains(id) {
                errors.push(format!(
                    "curation.json recommendation reason references missing scene: {id}"
                ));
            }
        }
    }
    let texts = scenes.iter().map(searchable).collect::<Vec<_>>();
    if let Some(aliases) = curation["searchAliases"].as_object() {
        for (intent, aliases) in aliases {
            if !aliases.as_array().is_some_and(|items| !items.is_empty()) {
                errors.push(format!(
                    "curation.json search alias must be a non-empty array: {intent}"
                ));
                continue;
            }
            let candidates = std::iter::once(intent.to_lowercase())
                .chain(
                    list(aliases)
                        .iter()
                        .map(|value| string(value).to_lowercase()),
                )
                .collect::<Vec<_>>();
            if !texts
                .iter()
                .any(|text| candidates.iter().any(|candidate| text.contains(candidate)))
            {
                errors.push(format!(
                    "curation.json search alias returns no scenes: {intent}"
                ));
            }
        }
    }
    for rail in rails {
        let id = string(&rail["id"]);
        let label = if id.is_empty() { "mood rail" } else { &id };
        if ["id", "title", "query"]
            .iter()
            .any(|key| !prompt::truthy(&rail[*key]))
        {
            errors.push(format!(
                "{label}: curation mood rail is missing id, title, or query"
            ));
            continue;
        }
        let query = string(&rail["query"]);
        let lower = query.to_lowercase();
        let terms = prompt::re!(r"\s+")
            .split(&lower)
            .filter(|term| !term.is_empty())
            .collect::<Vec<_>>();
        if !texts
            .iter()
            .any(|text| terms.iter().all(|term| text.contains(term)))
        {
            errors.push(format!(
                "{label}: curation query returns no scenes: {query}"
            ));
        }
    }
    for (id, traits) in [
        (
            "nene",
            vec![
                "white_hair",
                "low_twintails",
                "purple_eyes",
                "ahoge",
                "hair_ribbon",
            ],
        ),
        (
            "natsume",
            vec![
                "black_hair",
                "long_hair",
                "yellow_eyes",
                "mole_under_eye",
                "hairclip",
            ],
        ),
    ] {
        let Some(character) = list(characters)
            .iter()
            .find(|character| character["id"] == id)
        else {
            errors.push(format!("characters.json missing {id}"));
            continue;
        };
        for tag in traits {
            if !list(&character["traits"])
                .iter()
                .any(|value| value["tag"] == tag)
            {
                errors.push(format!("{id}: missing visual trait {tag}"));
            }
        }
        if !prompt::truthy(&character["lora"]["name"]) {
            errors.push(format!("{id}: missing LoRA binding"));
        }
        let recommendations = list(&character["lora"]["recommended_scene"]);
        if recommendations.is_empty() {
            errors.push(format!("{id}: missing recommended scenes"));
            continue;
        }
        for scene_id in recommendations {
            let scene = scenes.iter().find(|scene| scene["id"] == *scene_id);
            match scene {
                None => errors.push(format!(
                    "{id}: recommended scene does not exist: {}",
                    string(scene_id)
                )),
                Some(scene)
                    if scene["char"] != id
                        && !list(&scene["character"]).iter().any(|value| value == id) =>
                {
                    errors.push(format!(
                        "{id}: recommended scene belongs to another character: {}",
                        string(scene_id)
                    ))
                }
                _ => {}
            }
        }
    }
    let profiles = list(&presets["model_profiles"]);
    let presets = list(&presets["presets"]);
    if profiles.is_empty() {
        errors.push("presets.json must define model_profiles".into());
    }
    if presets.is_empty() {
        errors.push("presets.json must define presets".into());
    }
    let mut seen = HashSet::new();
    for profile in profiles {
        let id = string(&profile["id"]);
        if !prompt::truthy(&profile["id"]) {
            errors.push("model profile missing id".into());
            continue;
        }
        if !seen.insert(id.clone()) {
            errors.push(format!("{id}: duplicate model profile id"));
        }
        if !profile["match"]
            .as_array()
            .is_some_and(|values| !values.is_empty())
        {
            errors.push(format!("{id}: missing model match patterns"));
        }
        if !profile["quality_prefix"].is_string()
            || !profile["negative_prefix"].is_string()
            || (profile["engine"] != "krea2"
                && prompt::trim(&string(&profile["negative_prefix"])).is_empty())
        {
            errors.push(format!("{id}: invalid prompt prefixes"));
        }
        if !prompt::truthy(&profile["sampler"])
            || profile.get("steps").and_then(number).is_none()
            || profile.get("cfg").and_then(number).is_none()
        {
            errors.push(format!("{id}: invalid generation defaults"));
        }
        if !prompt::re!(r"^[0-9]+×[0-9]+$").is_match(&string(&profile["size"])) {
            errors.push(format!("{id}: invalid output size"));
        }
    }
    for id in [
        "wai_illustrious_v17",
        "anima_base_v10",
        "anima_aesthetic_v11",
        "anima_miaomiao_v16",
        "krea2_turbo_fp8",
    ] {
        if !seen.contains(id) {
            errors.push(format!("presets.json missing model profile {id}"));
        }
    }
    let mut seen = HashSet::new();
    for preset in presets {
        let id = string(&preset["id"]);
        if !prompt::truthy(&preset["id"]) || !prompt::truthy(&preset["name"]) {
            errors.push("preset missing id or name".into());
            continue;
        }
        if !seen.insert(id.clone()) {
            errors.push(format!("{id}: duplicate preset id"));
        }
        if !prompt::truthy(&preset["sampler"])
            || preset.get("steps").and_then(number).is_none()
            || preset.get("cfg").and_then(number).is_none()
        {
            errors.push(format!("{id}: invalid generation values"));
        }
        if !prompt::re!(r"^[0-9]+×[0-9]+$").is_match(&string(&preset["size"])) {
            errors.push(format!("{id}: invalid output size"));
        }
    }
}
