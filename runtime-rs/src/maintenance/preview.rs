use super::{Result, context::Options};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn diff(before: &[Value], after: &[Value]) -> Value {
    let old = before
        .iter()
        .map(|item| (item["id"].as_str().unwrap(), item))
        .collect::<HashMap<_, _>>();
    let next = after
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect::<HashSet<_>>();
    json!({"added":after.iter().filter(|item|!old.contains_key(item["id"].as_str().unwrap())).map(|item|item["id"].clone()).collect::<Vec<_>>(),
        "updated":after.iter().filter(|item|old.get(item["id"].as_str().unwrap()).is_some_and(|before|crate::storage::stringify(before)!=crate::storage::stringify(item))).map(|item|item["id"].clone()).collect::<Vec<_>>(),
        "removed":before.iter().filter(|item|!next.contains(item["id"].as_str().unwrap())).map(|item|item["id"].clone()).collect::<Vec<_>>()})
}
pub(super) fn run(options: &Options, body: &Value) -> Result<Value> {
    let prepared = super::save::prepare(options, body, false)?;
    let current = &prepared.state.value["snapshot"];
    let scenes = current["scenes"].as_array().unwrap();
    let version = prepared.version;
    let next = prepared.scenes;
    let next_blueprints = prepared.next_blueprints;
    let changes = diff(scenes, &next);
    let affected = ["added", "updated", "removed"]
        .into_iter()
        .flat_map(|key| {
            changes[key]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
        })
        .collect::<HashSet<_>>();
    let mut related = Vec::new();
    if let Some(curation) = current["curation"].as_object() {
        for (key, value) in curation {
            let ids = if let Some(values) = value.as_array() {
                values.iter().filter_map(Value::as_str).collect::<Vec<_>>()
            } else {
                value
                    .as_object()
                    .map(|map| map.keys().map(String::as_str).collect())
                    .unwrap_or_default()
            };
            for id in ids {
                if affected.contains(id) {
                    related.push(
                        json!({"kind":"curation","id":id,"reason":format!("策展引用：{key}")}),
                    );
                }
            }
        }
    }
    for scene in &next {
        if affected.contains(scene["id"].as_str().unwrap()) {
            related.push(json!({"kind":"scene","id":scene["id"],"reason":format!("角色：{}；服装：{}",scene["char"].as_str().filter(|s|!s.is_empty()).unwrap_or("未知"),scene["outfitId"].as_str().filter(|s|!s.is_empty()).unwrap_or("未声明"))}));
        }
    }
    let blueprint_changes = diff(
        current["blueprints"].as_array().unwrap(),
        next_blueprints
            .as_deref()
            .unwrap_or(current["blueprints"].as_array().unwrap()),
    );
    if let Some(blueprints) = &next_blueprints {
        for blueprint in blueprints {
            if ["added", "updated"].iter().any(|key| {
                blueprint_changes[*key]
                    .as_array()
                    .unwrap()
                    .contains(&blueprint["id"])
            }) {
                related.push(json!({"kind":"blueprint","id":blueprint["id"],"reason":format!("角色：{}；服装：{}",blueprint["characterId"].as_str().unwrap_or(""),blueprint["outfitId"].as_str().filter(|s|!s.is_empty()).unwrap_or("未声明"))}));
            }
        }
    }
    let mut checks = vec![
        "场景源分片完整性与读取基线",
        "定稿保护、退役身份、标签与策展校验",
        "保存后场景校验、压缩产物与版本一致性",
    ];
    if next_blueprints.is_some() {
        checks.push("蓝图源分片计划与完整内容契约");
    }
    Ok(
        json!({"ok":true,"baseVersion":version,"version":version,"added":changes["added"],"updated":changes["updated"],"removed":changes["removed"],"blueprints":blueprint_changes,"related":related,
        "checks":checks,
        "unknown":["外部样张、真实模型画面与主力机设备尚未验收；结构预览不会修改审核结论。"],"writesEnabled":true,"validationScope":"scene-structural-preview"}),
    )
}
