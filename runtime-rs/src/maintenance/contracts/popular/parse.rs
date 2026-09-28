use super::*;
pub(super) fn strings(value: &Value) -> Vec<&str> {
    list(value).iter().filter_map(Value::as_str).collect()
}
fn required(value: &Value, key: &str) -> std::result::Result<String, String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("popular data: {key} must be a non-empty string"))
}
fn copy_strings(source: &Value, target: &mut Value, fields: &[&str]) {
    for field in fields {
        target[*field] = json!(strings(&source[*field]));
    }
}
fn one_character(value: &Value) -> std::result::Result<Option<Value>, String> {
    if !value.is_object() {
        return Ok(None);
    }
    let mut output = json!({});
    for field in [
        "id",
        "displayName",
        "originalName",
        "franchise",
        "identityProse",
        "recommendedEngine",
    ] {
        output[field] = json!(required(value, field)?);
    }
    copy_strings(
        value,
        &mut output,
        &[
            "identityTokens",
            "exactTokens",
            "exactPrefixes",
            "aliases",
            "supportedEngines",
            "curatedArtistStyles",
        ],
    );
    if list(&output["identityTokens"]).is_empty() {
        return Err("popular data: identityTokens must be a non-empty string array".into());
    }
    let mut outfits = Vec::new();
    for outfit in list(&value["outfits"]) {
        if !outfit.is_object() {
            continue;
        }
        let id = required(outfit, "id")?;
        let tokens = strings(&outfit["tokens"]);
        if tokens.is_empty() {
            return Err(format!("popular data: outfit {id} requires tokens"));
        }
        outfits.push(json!({"id":id,"name":required(outfit,"name")?,"prose":required(outfit,"prose")?,"tokens":tokens,"default":outfit["default"]==true}));
    }
    if outfits.is_empty() {
        return Err(format!(
            "popular data: {} requires at least one outfit",
            text(&output["id"])
        ));
    }
    if !matches!(
        value["adultEligibility"].as_str(),
        Some("adult" | "unknown" | "underage")
    ) {
        return Err("popular data: adultEligibility must be one of adult/unknown/underage".into());
    }
    output["adultEligibility"] = value["adultEligibility"].clone();
    output["outfits"] = json!(outfits);
    if value["dnaLock"].is_object() {
        let mut dna = json!({});
        copy_strings(&value["dnaLock"], &mut dna, &["must", "flexible", "avoid"]);
        output["dnaLock"] = dna;
    }
    Ok(Some(output))
}
pub(super) fn characters(value: Value) -> std::result::Result<Vec<Value>, String> {
    let source = if value["characters"].is_array() {
        &value["characters"]
    } else {
        &value
    };
    let parsed: Vec<_> = list(source)
        .iter()
        .filter_map(|item| one_character(item).ok().flatten())
        .collect();
    let mut ids = HashSet::new();
    for character in &parsed {
        let id = text(&character["id"]);
        if !ids.insert(id.clone()) {
            return Err(format!("popular data: duplicated character id {id}"));
        }
        let mut outfits = HashSet::new();
        for outfit in list(&character["outfits"]) {
            let outfit_id = text(&outfit["id"]);
            if !outfits.insert(outfit_id.clone()) {
                return Err(format!(
                    "popular data: {id} has duplicated outfit id {outfit_id}"
                ));
            }
        }
    }
    Ok(parsed)
}
fn negative(value: &Value) -> Value {
    let values = if let Some(text) = value.as_str() {
        vec![text]
    } else {
        strings(value)
    };
    json!(
        values
            .into_iter()
            .flat_map(|s| s.split(','))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    )
}
fn one_blueprint(value: &Value) -> std::result::Result<Option<Value>, String> {
    if value.get("generatedRecipe").is_some() {
        crate::maintenance::generated::validate(value, true).map_err(|e| e.message)?;
        return Ok(Some(value.clone()));
    }
    if !value.is_object() {
        return Ok(None);
    }
    let mut output = json!({});
    for field in [
        "id",
        "title",
        "category",
        "description",
        "location",
        "action",
        "timeOfDay",
        "lighting",
        "camera",
        "mood",
        "promptProse",
        "recommendedSize",
    ] {
        output[field] = json!(required(value, field)?);
    }
    copy_strings(
        value,
        &mut output,
        &["sceneTags", "promptTokens", "coverageTags"],
    );
    if list(&output["promptTokens"]).is_empty() {
        return Err("popular data: promptTokens must be a non-empty string array".into());
    }
    for field in ["negativeTokens", "nsfwTokens"] {
        output[field] = negative(&value[field]);
    }
    output["adult"] = json!(value["adult"] == true);
    output["compositionIntent"] = match value["compositionIntent"].as_str() {
        Some("single" | "group" | "triptych") => value["compositionIntent"].clone(),
        None if value["compositionIntent"].is_null() => json!("single"),
        Some("") => json!("single"),
        _ => return Err("Invalid blueprint compositionIntent".into()),
    };
    for field in [
        "characterId",
        "kreaStyleHint",
        "animaStyleHint",
        "adultArtistHint",
        "sampleRating",
        "nsfwProse",
        "outfitId",
    ] {
        if let Some(text) = value[field].as_str()
            && !(field == "characterId" && text.is_empty())
        {
            output[field] = json!(text);
        }
    }
    Ok(Some(output))
}
pub(super) fn blueprints(value: Value) -> std::result::Result<Vec<Value>, String> {
    let source = if value["blueprints"].is_array() {
        &value["blueprints"]
    } else {
        &value
    };
    for item in list(source) {
        if item.get("generatedRecipe").is_some() {
            crate::maintenance::generated::validate(item, true).map_err(|e| e.message)?;
        }
    }
    let parsed: Vec<_> = list(source)
        .iter()
        .filter_map(|item| one_blueprint(item).ok().flatten())
        .collect();
    let mut ids = HashSet::new();
    for blueprint in &parsed {
        let id = text(&blueprint["id"]);
        if !ids.insert(id.clone()) {
            return Err(format!("blueprints: duplicated blueprint id {id}"));
        }
    }
    Ok(parsed)
}
