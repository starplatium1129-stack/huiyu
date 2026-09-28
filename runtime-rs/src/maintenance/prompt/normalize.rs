use super::{CONSTANTS, has, policy, strings, text, trim, truthy};
use crate::maintenance::{Error, Result};
use serde_json::{Value, json};
use std::collections::HashSet;

fn canonical(value: &str) -> String {
    let key = policy::token_key(value);
    if key.is_empty() || has(&CONSTANTS["optimizer"]["remove"], &key) {
        return String::new();
    }
    CONSTANTS["optimizer"]["aliases"][&key]
        .as_str()
        .unwrap_or(&key)
        .into()
}
fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| {
            let key = policy::token_key(value);
            !key.is_empty() && seen.insert(key)
        })
        .collect()
}
fn intent(scene: &Value) -> &'static str {
    let camera = text(&scene["camera"]);
    if re!(r"(?i)远景|全身|全景|wide|full.?body").is_match(&camera) {
        "wide"
    } else if re!(r"(?i)特写|近景|close").is_match(&camera) {
        "close"
    } else if re!(r"(?i)中景|medium").is_match(&camera) {
        "medium"
    } else {
        ""
    }
}
fn blocked(intent: &str) -> &'static [&'static str] {
    match intent {
        "wide" => &["close_up", "face_focus", "medium_shot", "upper_body"],
        "close" => &["medium_shot", "wide_shot", "full_body", "long_shot"],
        "medium" => &[
            "close_up",
            "face_focus",
            "wide_shot",
            "full_body",
            "long_shot",
        ],
        _ => &[],
    }
}
fn prompt(value: &str) -> String {
    let value = re!(r"\{[^}]+\}").replace_all(value, "");
    let value = re!(r"(?i)_break_").replace_all(&value, "BREAK");
    policy::segments(&value)
        .iter()
        .map(|section| {
            let mut seen = HashSet::new();
            section
                .iter()
                .filter_map(|token| {
                    let token = trim(token);
                    let leading = token.chars().next().filter(|c| ['(', '['].contains(c));
                    let trailing = token.chars().last().filter(|c| [')', ']'].contains(c));
                    let bare = if leading.is_some() {
                        &token[1..]
                    } else {
                        token
                    };
                    let bare = if trailing.is_some() {
                        &bare[..bare.len().saturating_sub(1)]
                    } else {
                        bare
                    };
                    if bare.to_lowercase().starts_with("<lora:") {
                        return Some(token.to_owned());
                    }
                    let mapped = canonical(bare);
                    if mapped.is_empty() || !seen.insert(policy::token_key(&mapped)) {
                        return None;
                    }
                    Some(format!(
                        "{}{}{}",
                        leading.map(|v| v.to_string()).unwrap_or_default(),
                        mapped,
                        trailing.map(|v| v.to_string()).unwrap_or_default()
                    ))
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" BREAK ")
}
pub(in crate::maintenance) fn optimize(scene: &Value, pins: &Value) -> Value {
    if truthy(&pins[&text(&scene["id"])]) || !trim(&text(&scene["auditRevision"])).is_empty() {
        return scene.clone();
    }
    let intent = intent(scene);
    let excluded = blocked(intent);
    let mut tags = dedupe(
        strings(&scene["tags"])
            .iter()
            .map(|value| canonical(value))
            .filter(|s| !s.is_empty())
            .collect(),
    );
    tags.retain(|value| !excluded.contains(&policy::token_key(value).as_str()));
    tags.extend(match intent {
        "wide" => vec!["wide_shot".into(), "full_body".into()],
        "close" => vec!["close_up".into()],
        "medium" => vec!["medium_shot".into()],
        _ => Vec::new(),
    });
    tags = dedupe(tags);
    if re!(r"(?i)主观|pov").is_match(&text(&scene["camera"]))
        && !tags.iter().any(|tag| tag == "pov")
    {
        tags.push("pov".into());
    }
    if scene["rating"] == "R18" && !tags.iter().any(|tag| tag == "adult") {
        tags.insert(0, "adult".into());
    }
    if scene["id"] == "sc064" {
        tags.retain(|tag| !["looking_at_viewer", "looking_back"].contains(&tag.as_str()));
    }
    let mut negative = strings(&CONSTANTS["optimizer"]["baseNegative"]);
    negative.extend(
        text(&scene["negative"])
            .split(',')
            .map(trim)
            .filter(|token| {
                !token.is_empty()
                    && ![
                        "nsfw",
                        "nude",
                        "explicit",
                        "child",
                        "loli",
                        "underage",
                        "school_uniform",
                        "gym_uniform",
                    ]
                    .contains(&policy::token_key(token).as_str())
            })
            .map(str::to_owned),
    );
    negative.extend(
        if scene["rating"] == "All" {
            vec!["nsfw", "nude", "explicit"]
        } else {
            let mut tokens = vec!["child", "loli", "underage"];
            if scene["rating"] == "R18" {
                tokens.extend(["school_uniform", "gym_uniform"]);
            }
            tokens
        }
        .into_iter()
        .map(str::to_owned),
    );
    let mut prompt = prompt(&text(&scene["prompt"]));
    if !excluded.is_empty() {
        prompt = re!(r"(?i)\s+BREAK\s+")
            .split(&prompt)
            .map(|section| {
                section
                    .split(',')
                    .map(trim)
                    .filter(|token| !excluded.contains(&policy::token_key(token).as_str()))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .collect::<Vec<_>>()
            .join(" BREAK ");
    }
    if scene["rating"] == "R18" {
        let first = re!(r"(?i)\s+BREAK\s+.*").replace(&prompt, "");
        if !first
            .split(',')
            .map(policy::token_key)
            .any(|key| key == "adult")
        {
            prompt = if re!(r"(?i)^\s*(?:1girl|2girls|3girls|1woman|2women)\s*,").is_match(&prompt)
            {
                re!(r"(?i)^(\s*(?:1girl|2girls|3girls|1woman|2women)\s*,)")
                    .replace(&prompt, "${1} adult,")
                    .into_owned()
            } else {
                format!("adult, {prompt}")
            };
        }
    }
    if scene["id"] == "sc064" {
        prompt = prompt
            .split(',')
            .map(trim)
            .filter(|token| {
                !["looking_at_viewer", "looking_back"].contains(&policy::token_key(token).as_str())
            })
            .collect::<Vec<_>>()
            .join(", ");
    }
    let mut output = scene.clone();
    output["tags"] = tags.into();
    output["prompt"] = prompt.into();
    output["negative"] = dedupe(negative).join(", ").into();
    output
}
pub(in crate::maintenance) fn classify(input: &[Value], pins: &Value) -> Result<Vec<Value>> {
    let mut ids = HashSet::new();
    for scene in input {
        let id = text(&scene["id"]);
        if !re!(r"^sc[0-9]+$").is_match(&id)
            || !ids.insert(id.clone())
            || !matches!(scene["rating"].as_str(), Some("All" | "R15" | "R18"))
            || !scene["mature"].is_boolean()
            || !scene["category"].is_string()
            || scene["usage"]
                .as_array()
                .is_none_or(|items| items.iter().any(|item| !item.is_string()))
        {
            return Err(Error::invalid(format!(
                "Invalid or missing rating fields: {id}"
            )));
        }
    }
    let mut output = input.to_vec();
    for addition in CONSTANTS["additions"].as_array().unwrap() {
        if !ids.contains(addition["id"].as_str().unwrap()) {
            output.push(addition.clone());
        }
    }
    for scene in &mut output {
        let id = text(&scene["id"]);
        if truthy(&pins[&id]) {
            continue;
        }
        let rating = CONSTANTS["manual"][&id].as_str().unwrap_or_else(|| {
            if scene["mature"] == true || scene["rating"] == "R18" {
                "R18"
            } else {
                policy::rating(scene)
            }
        });
        let category = text(&scene["category"]);
        let category = if category.is_empty() {
            "日常"
        } else {
            &category
        };
        let category = match (rating, category) {
            ("All", "亲密") => "恋爱",
            ("All", "亲密/After_Story") => "恋爱/After_Story",
            (_, category) => category,
        };
        let mut usage = strings(&scene["usage"])
            .into_iter()
            .filter(|item| !["R18", "R15", "全年龄", "成人向"].contains(&item.as_str()))
            .collect::<Vec<_>>();
        if rating == "R18" {
            usage.push("成人向".into());
        } else if rating == "R15" {
            usage.push("R15".into());
        }
        scene["rating"] = rating.into();
        scene["mature"] = json!(rating == "R18");
        scene["category"] = category.into();
        scene["usage"] = usage.into();
    }
    Ok(output)
}
