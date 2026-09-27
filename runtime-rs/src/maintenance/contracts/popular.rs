use super::*;
mod parse;
use parse::{blueprints, characters, strings};
use std::sync::LazyLock;
static STUDIO_NAME: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)(?:ayachi_nene|shiki_natsume)").unwrap());
static STUDIO_PREFIX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)(?:^|[^a-z0-9_])(?:nene|natsume)_[a-z0-9_]+").unwrap()
});

fn leaks(text: &str) -> Vec<&'static str> {
    let mut leaks = vec![];
    if STUDIO_NAME.is_match(text) {
        leaks.push("studio character name");
    }
    if STUDIO_PREFIX.is_match(text) {
        leaks.push("studio control prefix");
    }
    leaks
}
fn environment(tokens: Vec<&str>) -> Vec<&str> {
    tokens
        .into_iter()
        .filter(|t| {
            [
                "beach",
                "summer",
                "winter",
                "autumn",
                "ocean",
                "sea",
                "underwater",
                "swimming_pool",
                "poolside",
                "indoors",
                "outdoors",
                "nightlife",
                "classroom",
                "library",
                "bedroom",
                "festival",
            ]
            .contains(&t.to_lowercase().as_str())
        })
        .collect()
}
pub(super) fn validate(root: &Path, issues: &mut Vec<String>) {
    if let Err(error) = run(root, issues) {
        issues.push(format!(
            "popular/scene-blueprints data failed to parse: {error}"
        ));
    }
}
fn run(root: &Path, issues: &mut Vec<String>) -> std::result::Result<(), String> {
    let characters = characters(read(root, "data/popular-characters.json")?)?;
    let blueprints = blueprints(read(root, "data/scene-blueprints.json")?)?;
    if characters.is_empty() {
        issues.push("popular-characters.json must contain at least one character".into());
    }
    for character in &characters {
        let id = character["id"].as_str().unwrap();
        if list(&character["outfits"])
            .iter()
            .filter(|o| o["default"] == true)
            .count()
            != 1
        {
            issues.push(format!("{id} must have exactly one default outfit"));
        }
        for field in [
            "identityProse",
            "aliases",
            "exactPrefixes",
            "identityTokens",
            "exactTokens",
        ] {
            let value = if field == "identityProse" {
                text(&character[field])
            } else {
                strings(&character[field]).join(", ")
            };
            for leak in leaks(&value) {
                issues.push(format!("pollution: {id}.{field}: {leak}"));
            }
        }
        for token in environment(strings(&character["identityTokens"])) {
            issues.push(format!(
                "pollution: {id}.identityTokens: environment token \"{token}\""
            ));
        }
        for outfit in list(&character["outfits"]) {
            let outfit_id = text(&outfit["id"]);
            for leak in leaks(&format!(
                "{} {}",
                text(&outfit["prose"]),
                strings(&outfit["tokens"]).join(" ")
            )) {
                issues.push(format!("pollution: {id}.outfit.{outfit_id}: {leak}"));
            }
            for token in environment(strings(&outfit["tokens"])) {
                issues.push(format!(
                    "pollution: {id}.outfit.{outfit_id}: environment token \"{token}\""
                ));
            }
        }
    }
    if blueprints.len() < 20 {
        issues.push("scene-blueprints.json must contain at least 20 blueprints".into());
    }
    if !blueprints.iter().any(|b| b["adult"] == true) {
        issues.push("scene-blueprints.json should keep at least one adult-only blueprint gated by adultEligibility".into());
    }
    let recipes: Value =
        serde_json::from_str(include_str!("recipes.json")).expect("checked recipe snapshot");
    let metadata = regex::Regex::new(r"(?i)(?:official_cg|visual_audited)").unwrap();
    for blueprint in &blueprints {
        let id = text(&blueprint["id"]);
        let body = crate::storage::stringify(blueprint);
        if !leaks(&body).is_empty() {
            issues.push(format!(
                "blueprint {id} must not reference nene/natsume tokens"
            ));
        }
        if metadata.is_match(&body) {
            issues.push(format!("blueprint {id} must not leak retrieval metadata"));
        }
        for field in ["kreaStyleHint", "animaStyleHint"] {
            if let Some(hint) = blueprint[field].as_str().filter(|s| !s.trim().is_empty())
                && let Some(recipe) = list(&recipes).iter().find(|r| r["id"] == hint)
                && recipe["adult"] == true
                && blueprint["adult"] != true
            {
                issues.push(format!("blueprint {id} {field} references adult recipe {} but the blueprint is not adult",text(&recipe["id"])));
            }
        }
    }
    let common = list(&recipes).iter().filter(|r| r["adult"] != true).count();
    if common < 8 {
        issues.push(format!(
            "kreaStyleRecipes must ship at least 8 common recipes, got {common}"
        ));
    }
    if !list(&recipes).iter().any(|r| r["adult"] == true) {
        issues.push("kreaStyleRecipes must ship explicit adult-only recipes".into());
    }
    let tokens = regex::Regex::new(r"(?i)(?:ayachi_nene|shiki_natsume|nene_|natsume_)").unwrap();
    for recipe in list(&recipes) {
        let id = text(&recipe["id"]);
        if recipe["lead"].as_str().is_none_or(|s| s.trim().is_empty()) {
            issues.push(format!("kreaStyleRecipes.{id} must have a lead phrase"));
        }
        if tokens.is_match(&format!(
            "{} {}",
            text(&recipe["lead"]),
            recipe["medium"].as_str().unwrap_or("")
        )) {
            issues.push(format!(
                "kreaStyleRecipes.{id} must not reference studio LoRA tokens"
            ));
        }
    }
    Ok(())
}
