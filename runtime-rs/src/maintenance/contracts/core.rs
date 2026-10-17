use super::*;

pub(super) fn validate(
    root: &DataRoot,
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
                let file = root.join("data").join(path);
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
