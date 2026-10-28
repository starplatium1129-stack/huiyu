use super::*;
use std::collections::HashSet;
use std::sync::LazyLock;

static PLACEHOLDER: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\{\{[^{}\r\n]+\}\}|\$\{[^{}\r\n]+\}|<(?:character|character_id|outfit|outfit_id|scene|prompt|name)>").unwrap()
});
static RETRIEVAL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)(?:^|[^a-z0-9_])(?:official[ _]cg|visual[ _]audited)(?:$|[^a-z0-9_])")
        .unwrap()
});

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Issue {
    kind: String,
    id: String,
    field: String,
    code: &'static str,
    severity: &'static str,
    message: String,
}

fn fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "character" => &[
            "popular.identityProse",
            "popular.identityTokens",
            "popular.negativeTokens",
            "popular.exactTokens",
            "popular.exactPrefixes",
            "popular.aliases",
            "popular.characterTokens",
            "popular.copyrightTokens",
        ],
        "outfit" => &[
            "outfit.prose",
            "outfit.tokens",
            "outfit.identityTokensOverride",
            "outfit.identityProseOverride",
        ],
        "scene" => &[
            "prompt",
            "negative",
            "animaCaption",
            "promptProse",
            "identityTokensOverride",
            "identityProseOverride",
        ],
        "blueprint" => &[
            "promptTokens",
            "negativeTokens",
            "promptProse",
            "animaCaption",
            "nsfwTokens",
            "nsfwProse",
            "identityTokensOverride",
            "identityProseOverride",
            "characterTokens",
        ],
        _ => &[],
    }
}

fn at<'a>(data: &'a Value, field: &str) -> &'a Value {
    field.split('.').fold(data, |value, key| &value[key])
}

fn strings(value: &Value) -> Vec<&str> {
    if let Some(value) = value.as_str() {
        vec![value]
    } else {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect()
    }
}

fn tokens(value: &Value) -> HashSet<String> {
    strings(value)
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_lowercase().replace('_', " "))
        .filter(|token| !token.is_empty())
        .collect()
}

fn issue(
    kind: &str,
    id: &str,
    field: &str,
    code: &'static str,
    severity: &'static str,
    message: String,
) -> Issue {
    Issue {
        kind: kind.into(),
        id: id.into(),
        field: field.into(),
        code,
        severity,
        message,
    }
}

pub(super) fn policy() -> Value {
    json!({"id":"studio-prompt-craft/source-v1", "scope":"changed-source-fields",
        "blocks":["unresolved-placeholder", "retrieval-token", "studio-identity-leak", "environment-in-identity", "blueprint-negative-boilerplate"],
        "warnings":["model-default-in-content", "positive-negative-overlap"],
        "notChecked":["compiled-model-input", "semantic-intent", "rendered-image"],
        "pinnedFields":"existing-byte-baseline"})
}

/// Source checks are shared by preview, UI saves, CLI patches and imports.
/// They do not certify model semantics, compiled output or a rendered image.
pub(super) fn review(diffs: &[Value], connection: &Connection, source: &Path) -> Result<Value> {
    let mut issues = Vec::new();
    let mut checked_fields = 0;
    let mut pins = validation::PinPolicy::default();
    for diff in diffs {
        let kind = diff["kind"].as_str().unwrap_or("");
        let id = diff["id"].as_str().unwrap_or("");
        if diff["after"].is_null() {
            continue;
        }
        let before = &diff["before"]["data"];
        let after = &diff["after"]["data"];
        let pinned =
            kind == "scene" && pins.select(connection, source)?["scenes"].get(id).is_some();
        let context_changed = [
            "adult",
            "outfitId",
            "characterId",
            "char",
            "generatedRecipe",
        ]
        .iter()
        .any(|field| before[*field] != after[*field]);
        if matches!(kind, "scene" | "blueprint")
            && after.get("generatedRecipe").is_some()
            && (context_changed
                || fields(kind)
                    .iter()
                    .any(|field| at(before, field) != at(after, field)))
        {
            crate::maintenance::generated::validate(after, kind == "blueprint").map_err(
                |error| {
                    ApiError::invalid(format!("{kind}:{id}.generatedRecipe: {}", error.message))
                },
            )?;
        }
        let mut changed = false;
        for field in fields(kind) {
            let value = at(after, field);
            if !context_changed && value == at(before, field)
                || pinned && validation::PINNED_FIELDS.contains(field)
            {
                continue;
            }
            changed = true;
            checked_fields += 1;
            for (code, message) in
                crate::maintenance::contracts::authored_field_issues(kind, field, value)
            {
                issues.push(issue(kind, id, field, code, "error", message));
            }
            for text in strings(value) {
                if let Some(found) = PLACEHOLDER.find(text) {
                    issues.push(issue(
                        kind,
                        id,
                        field,
                        "unresolved-placeholder",
                        "error",
                        format!("存在未替换占位符 {}", found.as_str()),
                    ));
                }
                if let Some(found) = RETRIEVAL.find(text) {
                    issues.push(issue(
                        kind,
                        id,
                        field,
                        "retrieval-token",
                        "error",
                        format!("检索标签 {} 不能作为模型提示词", found.as_str().trim()),
                    ));
                }
            }
            let values = tokens(value);
            // A captured generation recipe contains the final model defaults by design.
            // Editorial blueprints only own scene-specific exclusions.
            if kind == "blueprint"
                && *field == "negativeTokens"
                && after.get("generatedRecipe").is_none()
            {
                let defaults: Vec<_> = [
                    "worst quality",
                    "low quality",
                    "normal quality",
                    "bad quality",
                    "score 1",
                    "score 2",
                    "score 3",
                    "bad anatomy",
                    "bad hands",
                    "bad fingers",
                    "extra fingers",
                    "missing fingers",
                    "extra limbs",
                    "missing limbs",
                    "mutated hands",
                    "blurry",
                    "jpeg artifacts",
                    "artist name",
                ]
                .into_iter()
                .filter(|token| values.contains(*token))
                .collect();
                if !defaults.is_empty() {
                    issues.push(issue(kind, id, field, "blueprint-negative-boilerplate", "error", format!("蓝图混入通用质量／解剖负面模板 {}；基础负面由模型 profile 管理，无画面专属排除项时请使用 []", defaults.join(", "))));
                }
            }
            if after.get("generatedRecipe").is_none() && matches!(*field, "prompt" | "promptTokens")
            {
                let defaults: Vec<_> = [
                    "masterpiece",
                    "best quality",
                    "score 7",
                    "score 9",
                    "very aesthetic",
                ]
                .into_iter()
                .filter(|token| values.contains(*token))
                .collect();
                if !defaults.is_empty() {
                    issues.push(issue(
                        kind,
                        id,
                        field,
                        "model-default-in-content",
                        "warning",
                        format!(
                            "画面字段含模型层常用词 {}；请按目标 checkpoint 核对，避免重复配方",
                            defaults.join(", ")
                        ),
                    ));
                }
            }
        }
        if !changed {
            continue;
        }
        let (positive, negative) = match kind {
            "scene" => (tokens(&after["prompt"]), tokens(&after["negative"])),
            "blueprint" => {
                let mut positive = tokens(&after["promptTokens"]);
                if after["adult"] == true {
                    positive.extend(tokens(&after["nsfwTokens"]));
                }
                (positive, tokens(&after["negativeTokens"]))
            }
            _ => (HashSet::new(), HashSet::new()),
        };
        let mut overlap: Vec<_> = positive.intersection(&negative).cloned().collect();
        overlap.sort();
        if !overlap.is_empty() {
            issues.push(issue(
                kind,
                id,
                if kind == "blueprint" {
                    "negativeTokens"
                } else {
                    "negative"
                },
                "positive-negative-overlap",
                "warning",
                format!(
                    "正负向存在同一词条 {}；请核对是否为有意排除或作用域表达",
                    overlap.join(", ")
                ),
            ));
        }
    }
    let blocked: Vec<_> = issues
        .iter()
        .filter(|issue| issue.severity == "error")
        .collect();
    if !blocked.is_empty() {
        let details = blocked
            .iter()
            .take(12)
            .map(|issue| {
                format!(
                    "{}:{}.{} [{}] {}",
                    issue.kind, issue.id, issue.field, issue.code, issue.message
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        return Err(ApiError::new(
            422,
            "PROMPT_CRAFT_REJECTED",
            format!(
                "提示词规范检查拦截 {} 项问题，整批未保存：\n{details}",
                blocked.len()
            ),
        ));
    }
    Ok(
        json!({"policy":"studio-prompt-craft/source-v1","checkedFields":checked_fields,"issues":issues,"visualReview":"not-performed"}),
    )
}
