use super::*;

pub(super) fn validate(
    root: &DataRoot,
    assets: Option<&Path>,
    data: &Value,
    issues: &mut Vec<String>,
) {
    let (characters, loras, scenes) = (&data["characters"], &data["loras"], &data["scenes"]);
    let initial = issues.len();
    if !characters.is_array() || list(characters).is_empty() {
        issues.push("characters.json must contain at least one character".into());
    }
    if !loras.is_array() || list(loras).is_empty() {
        issues.push("loras.json must contain at least one LoRA".into());
    }
    if !scenes.is_array() {
        issues.push("scenes.json must be an array".into());
    }
    if issues.len() != initial {
        return;
    }
    let mut character_ids = HashSet::new();
    let mut character_loras = HashSet::new();
    let id_re = regex::Regex::new(r"^[a-z][a-z0-9_-]*$").unwrap();
    for (index, character) in list(characters).iter().enumerate() {
        let label = format!("characters[{index}]");
        if !character.is_object() {
            issues.push(format!("{label} must be an object"));
            continue;
        }
        let id = property(character, "id");
        if !id_re.is_match(&id) {
            issues.push(format!("{label}.id must be a stable lowercase key"));
        }
        if !character_ids.insert(key(character.get("id"))) {
            issues.push(format!("{label}.id is duplicated: {id}"));
        }
        for field in ["name", "source", "speech"] {
            if character[field]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
            {
                issues.push(format!("{label}.{field} is required"));
            }
        }
        match character["portrait"]["image"].as_str() {
            None => issues.push(format!("{label}.portrait.image is required")),
            Some(image) => {
                let path = image.split('?').next().unwrap_or(image);
                let file = match (
                    assets,
                    path.strip_prefix("../assets/")
                        .or_else(|| path.strip_prefix("/assets/")),
                ) {
                    (Some(assets), Some(relative)) => assets.join(relative),
                    _ => root.join("data").join(path),
                };
                if !file.exists() {
                    issues.push(format!("{label}.portrait.image does not exist: {image}"));
                }
            }
        }
        if !truthy(&character["visual_dna"]["signature"]) {
            issues.push(format!("{label}.visual_dna.signature is required"));
        }
        if list(&character["traits"]).len() < 3 {
            issues.push(format!("{label}.traits must contain identity anchors"));
        }
        if character["type"] != "popular" {
            if let Some(name) = character["lora"]["name"].as_str() {
                character_loras.insert(name.to_owned());
            } else {
                issues.push(format!("{label}.lora.name is required"));
            }
            let weight = number(character["lora"].get("weight"));
            if !(weight > 0. && weight <= 2.) {
                issues.push(format!("{label}.lora.weight must be in (0, 2]"));
            }
        }
    }
    let mut lora_ids = HashSet::new();
    let mut lora_names = HashSet::new();
    let scene_ids: HashSet<_> = list(scenes)
        .iter()
        .filter(|s| truthy(&s["id"]))
        .map(|s| key(s.get("id")))
        .collect();
    for (index, lora) in list(loras).iter().enumerate() {
        let label = format!("loras[{index}]");
        if !lora.is_object() {
            issues.push(format!("{label} must be an object"));
            continue;
        }
        if !truthy(&lora["id"]) || !lora_ids.insert(key(lora.get("id"))) {
            issues.push(format!("{label}.id is missing or duplicated"));
        }
        if !truthy(&lora["name"]) || !lora_names.insert(key(lora.get("name"))) {
            issues.push(format!("{label}.name is missing or duplicated"));
        }
        let strength = &lora["strength"];
        if !(number(strength.get("min")) <= number(strength.get("default"))
            && number(strength.get("default")) <= number(strength.get("max")))
        {
            issues.push(format!(
                "{label}.strength must satisfy min <= default <= max"
            ));
        }
        if list(&lora["compatible_models"]).is_empty() {
            issues.push(format!("{label}.compatible_models is required"));
        }
        for scene in list(&lora["test_scene"]) {
            if !scene_ids.contains(&key(Some(scene))) {
                issues.push(format!(
                    "{label}.test_scene references unknown scene: {}",
                    text(scene)
                ));
            }
        }
    }
    for name in character_loras {
        if !lora_names.contains(&key(Some(&json!(name)))) {
            issues.push(format!("character references unknown LoRA: {name}"));
        }
    }
    for (index, scene) in list(scenes).iter().enumerate() {
        if truthy(&scene["char"]) {
            if scene["char"] != "triad" && !character_ids.contains(&key(scene.get("char"))) {
                issues.push(format!(
                    "scenes[{index}].char references unknown character: {}",
                    property(scene, "char")
                ));
            }
            for id in list(&scene["character"]) {
                if !character_ids.contains(&key(Some(id))) {
                    issues.push(format!(
                        "scenes[{index}].character references unknown character: {}",
                        text(id)
                    ));
                }
            }
        }
        if scene["rating"] == "R18" && !truthy(&scene["mature"]) {
            issues.push(format!(
                "scene {}: rating=R18 但 mature!=true（红线 4 分级互锁）",
                property(scene, "id")
            ));
        }
        if truthy(&scene["mature"]) && scene["rating"] != "R18" {
            issues.push(format!(
                "scene {}: mature=true 但 rating={}（红线 4 分级互锁）",
                property(scene, "id"),
                key(scene.get("rating"))
            ));
        }
    }
}
pub(super) fn shards(root: &DataRoot, data: &Value, issues: &mut Vec<String>) {
    let Some(scenes) = data["scenes"].as_array() else {
        return;
    };
    let by_id: std::collections::HashMap<_, _> =
        scenes.iter().map(|s| (key(s.get("id")), s)).collect();
    let mut seen = HashSet::new();
    for character in ["nene", "natsume", "shared"] {
        let file = format!("scenes-{character}.json");
        match read(root, &format!("data/{file}")) {
            Ok(value) => {
                if !value.is_array() {
                    issues.push(format!("{file} must be an array"));
                }
                for scene in list(&value) {
                    if !truthy(&scene["id"]) {
                        issues.push(format!("{file} contains an item without id"));
                        continue;
                    }
                    let id = property(scene, "id");
                    let identity = key(scene.get("id"));
                    if !seen.insert(identity.clone()) {
                        issues.push(format!("{id} appears in multiple browser shards"));
                        continue;
                    }
                    let Some(canonical) = by_id.get(&identity) else {
                        issues.push(format!("{file} contains unknown scene {id}"));
                        continue;
                    };
                    if crate::storage::stringify(scene) != crate::storage::stringify(canonical) {
                        issues.push(format!("{file} scene {id} differs from scenes.json"));
                    }
                    let expected = if scene["char"] == "natsume" {
                        "natsume"
                    } else if scene["char"] == "triad" {
                        "shared"
                    } else {
                        "nene"
                    };
                    if expected != character {
                        issues.push(format!(
                            "{id} is placed in {file} but char={}",
                            property(scene, "char")
                        ));
                    }
                }
            }
            Err(error) => issues.push(error),
        }
    }
    if seen.len() != scenes.len() {
        issues.push(format!(
            "browser shards cover {} scenes, expected {}",
            seen.len(),
            scenes.len()
        ));
    }
    match (
        read(root, "data/scenes-index.json"),
        read(root, "data/scenes-core.json"),
    ) {
        (Ok(index), Ok(core)) => {
            if number(index.get("total")) != scenes.len() as f64 {
                issues.push("scenes-index.json total mismatch".into());
            }
            let ids = list(&index["tiers"]["core"]);
            if !core.is_array() {
                issues.push("scenes-core.json must be an array".into());
            } else {
                if list(&core).len() != ids.len() {
                    issues.push("scenes-core.json length differs from index tiers.core".into());
                }
                for (position, id) in ids.iter().enumerate() {
                    if core[position]["id"] != *id || !by_id.contains_key(&key(Some(id))) {
                        issues.push(format!(
                            "scenes-core.json[{position}] does not match index tier id {}",
                            text(id)
                        ));
                    }
                }
                if list(&core)
                    .iter()
                    .any(|scene| !by_id.contains_key(&key(scene.get("id"))))
                {
                    issues.push("scenes-core.json references scenes outside scenes.json".into());
                }
            }
            if list(&index["orderedIds"]).len() != scenes.len() {
                issues.push("scenes-index.json orderedIds length mismatch".into());
            }
        }
        (left, right) => {
            for result in [left, right] {
                if let Err(error) = result {
                    issues.push(error);
                }
            }
        }
    }
}
