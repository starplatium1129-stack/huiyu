use super::{Error, Result, state};
use serde_json::{Value, json};
use std::collections::HashSet;

pub(crate) fn collection(items: &Value) -> Result<&Vec<Value>> {
    let items = items
        .as_array()
        .filter(|items| items.len() <= 10000)
        .ok_or_else(|| Error::invalid("场景 数据格式或数量超出限制"))?;
    let mut seen = HashSet::new();
    for scene in items {
        super::generated::validate(scene, false)?;
        let id = scene["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| Error::invalid("场景 ID 必须非空且唯一"))?;
        if !seen.insert(id) {
            return Err(Error::invalid(format!("场景 ID 必须非空且唯一：{id}")));
        }
        if state::scene_number(id).is_none() {
            return Err(Error::invalid(format!(
                "场景 ID 必须符合 sc001 / sc1000 格式：{id}"
            )));
        }
    }
    Ok(items)
}
fn text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null | Value::Bool(false) => String::new(),
        value => crate::storage::stringify(value),
    }
}
pub(crate) fn tags(value: &Value) -> Result<()> {
    let tags = value
        .as_array()
        .filter(|items| items.len() <= 2000)
        .ok_or_else(|| Error::invalid("Tag 数据格式错误或数量超出限制"))?;
    let mut ids = HashSet::new();
    for tag in tags {
        let id = text(&tag["id"]).trim().to_owned();
        let name = text(&tag["en"]).trim().to_owned();
        let category = text(&tag["cat"]).trim().to_owned();
        let chinese = text(&tag["cn"]).trim().to_owned();
        let weight = tag["weight"].as_f64().or_else(|| {
            tag["weight"]
                .as_str()
                .and_then(|value| value.trim().parse().ok())
        });
        if !id
            .strip_prefix("tag_")
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
            || !ids.insert(id.clone())
        {
            return Err(Error::invalid(format!(
                "Tag ID 必须唯一且符合 tag_001 格式：{id}"
            )));
        }
        if name.is_empty()
            || name.encode_utf16().count() > 120
            || name.contains(['\r', '\n', '<', '>'])
        {
            return Err(Error::invalid(format!(
                "Tag 英文名必须唯一且可用于 Prompt：{name}"
            )));
        }
        if category.is_empty() || chinese.is_empty() {
            return Err(Error::invalid(format!("{id} 必须填写分类和中文名")));
        }
        if !weight.is_some_and(|weight| weight.is_finite() && weight > 0.0 && weight <= 2.0) {
            return Err(Error::invalid(format!("{id} 的权重必须在 0 到 2 之间")));
        }
    }
    Ok(())
}
pub(crate) fn curation(value: &Value, active: &HashSet<&str>, previous: &Value) -> Result<Value> {
    let mut value = if value.is_object() {
        value.clone()
    } else {
        json!({})
    };
    let clean = |value: &Value| {
        let mut seen = HashSet::new();
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|id| active.contains(id) && seen.insert((*id).to_owned()))
                    .map(|id| Value::String(id.into()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let mut curated = clean(&value["curatedSceneIds"]);
    let signature = clean(&value["signatureSceneIds"]);
    for id in &signature {
        if !curated.contains(id) {
            curated.push(id.clone());
        }
    }
    let review = clean(&value["reviewSceneIds"])
        .into_iter()
        .filter(|id| !curated.contains(id))
        .collect::<Vec<_>>();
    value["curatedSceneIds"] = curated.into();
    value["signatureSceneIds"] = signature.clone().into();
    value["reviewSceneIds"] = review.into();
    if value.get("personaCoreSceneIds").is_none()
        && let Some(previous) = previous.get("personaCoreSceneIds")
    {
        value["personaCoreSceneIds"] = previous.clone();
    }
    if let Some(core) = value.get("personaCoreSceneIds") {
        if !core.is_array() {
            return Err(Error::invalid("personaCoreSceneIds 必须是场景 ID 数组"));
        }
        value["personaCoreSceneIds"] = clean(core).into();
    }
    let mut reasons = serde_json::Map::new();
    if let Some(source) = value["recommendationReasons"].as_object() {
        for (id, reason) in source {
            let reason = text(reason).trim().to_owned();
            if active.contains(id.as_str()) && !reason.is_empty() {
                reasons.insert(id.clone(), reason.into());
            }
        }
    }
    for id in signature {
        let id = id.as_str().unwrap();
        if !reasons.contains_key(id) {
            return Err(Error::invalid(format!(
                "{id} 标记为招牌场景时必须填写推荐理由"
            )));
        }
    }
    value["recommendationReasons"] = Value::Object(reasons);
    Ok(value)
}
