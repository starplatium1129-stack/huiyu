use super::*;
pub(super) fn key(kind: &str, id: &str) -> Result<()> {
    if !KINDS.contains(&kind)
        || id.is_empty()
        || id.trim() != id
        || id.len() > 240
        || id.chars().any(|c| c.is_control())
    {
        return Err(ApiError::invalid("记录类型或 ID 无效"));
    }
    Ok(())
}
pub(super) fn data(kind: &str, id: &str, value: &Value) -> Result<()> {
    key(kind, id)?;
    if kind == "document" {
        if !["curation", "tags", "tag-dictionary-policy"].contains(&id) {
            return Err(ApiError::invalid("此系统记录只能通过专用维护流程更新"));
        }
        if (id == "tags" && !value.is_array()) || (id != "tags" && !value.is_object()) {
            return Err(ApiError::invalid("标签或策展格式无效"));
        }
        if id == "tags" {
            crate::maintenance::validation::tags(value)
                .map_err(|e| ApiError::invalid(e.message))?;
        }
        return Ok(());
    }
    if !value.is_object() {
        return Err(ApiError::invalid("内容必须是对象"));
    }
    let has = |key: &str| value[key].as_str().is_some_and(|s| !s.trim().is_empty());
    match kind {
        "character" => {
            if value["id"] != id || (!value["profile"].is_object() && !value["popular"].is_object())
            {
                return Err(ApiError::invalid("人物需要稳定 ID 和档案或提示词身份"));
            }
            for field in ["profile", "popular"] {
                if value[field].is_object() && value[field]["id"] != id {
                    return Err(ApiError::invalid("人物档案和身份 ID 必须一致"));
                }
            }
            if value["profile"].is_object()
                && value["profile"]["name"]
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty())
            {
                return Err(ApiError::invalid("人物档案需要名称"));
            }
            if value["popular"].get("outfits").is_some() {
                return Err(ApiError::invalid("服装应独立维护，不能嵌入人物身份"));
            }
            if let Some(popular) = value.get("popular") {
                for key in [
                    "displayName",
                    "originalName",
                    "franchise",
                    "identityProse",
                    "recommendedEngine",
                ] {
                    if popular[key].as_str().is_none_or(|s| s.trim().is_empty()) {
                        return Err(ApiError::invalid(format!("人物身份缺少 {key}")));
                    }
                }
                if popular["identityTokens"]
                    .as_array()
                    .is_none_or(|items| items.is_empty() || items.iter().any(|v| !v.is_string()))
                {
                    return Err(ApiError::invalid("人物身份词条无效"));
                }
            }
        }
        "outfit" => {
            if !has("characterId")
                || !value["outfit"].is_object()
                || value["outfit"]["id"].as_str().is_none_or(|s| s.is_empty())
                || id
                    != format!(
                        "{}/{}",
                        value["characterId"].as_str().unwrap(),
                        value["outfit"]["id"].as_str().unwrap()
                    )
            {
                return Err(ApiError::invalid("服装 ID 与人物关联不一致"));
            }
            if value["outfit"]["name"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
                || value["outfit"]["prose"]
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty())
                || value["outfit"]["tokens"].as_array().is_none_or(|items| {
                    items.is_empty()
                        || items
                            .iter()
                            .any(|v| v.as_str().is_none_or(|s| s.is_empty()))
                })
            {
                return Err(ApiError::invalid("服装名称、描述与词条必填"));
            }
        }
        "scene" => {
            crate::maintenance::validation::collection(&json!([value]))
                .map_err(|e| ApiError::invalid(e.message))?;
            if value["id"] != id
                || !has("title")
                || !has("story")
                || !has("char")
                || crate::maintenance::state::scene_number(id).is_none()
            {
                return Err(ApiError::invalid("场景 ID、标题、故事和角色必填"));
            }
            if !["nene", "natsume", "triad"].contains(&value["char"].as_str().unwrap_or("")) {
                return Err(ApiError::invalid(
                    "工作室场景使用宁宁、夏目或双人；其他人物请创建蓝图",
                ));
            }
            if !["All", "R15", "R18"].contains(&value["rating"].as_str().unwrap_or(""))
                || !value["mature"].is_boolean()
                || (value["rating"] == "R18" && value["mature"] != true)
            {
                return Err(ApiError::invalid("场景分级与 mature 不一致"));
            }
            for field in ["prompt", "negative", "animaCaption"] {
                if value.get(field).is_some_and(|v| !v.is_string()) {
                    return Err(ApiError::invalid("提示词字段必须是字符串"));
                }
            }
        }
        "blueprint" => {
            crate::maintenance::blueprints::collection(&json!([value]))
                .map_err(|e| ApiError::invalid(e.message))?;
            if value["id"] != id
                || !has("title")
                || !has("characterId")
                || !value["promptProse"].is_string()
                || !value["promptTokens"].is_array()
                || !value["negativeTokens"].is_array()
            {
                return Err(ApiError::invalid("蓝图 ID、标题、角色与提示词字段不完整"));
            }
            if value.get("compositionIntent").is_some_and(|v| {
                !["single", "group", "triptych"].contains(&v.as_str().unwrap_or(""))
            }) || (value["adult"] == true
                && value
                    .get("compositionIntent")
                    .is_some_and(|v| v != "single"))
            {
                return Err(ApiError::invalid("蓝图构图与分级不一致"));
            }
            for key in ["category", "description", "recommendedSize"] {
                if !has(key) {
                    return Err(ApiError::invalid(format!("蓝图缺少 {key}")));
                }
            }
            if value.get("generatedRecipe").is_none() {
                for key in [
                    "location",
                    "action",
                    "timeOfDay",
                    "lighting",
                    "camera",
                    "mood",
                    "promptProse",
                ] {
                    if !has(key) {
                        return Err(ApiError::invalid(format!("蓝图缺少 {key}")));
                    }
                }
                if value["promptTokens"].as_array().is_none_or(Vec::is_empty) {
                    return Err(ApiError::invalid("蓝图正向词条不能为空"));
                }
            }
        }
        _ => (),
    }
    Ok(())
}
pub(super) fn pins(
    connection: &Connection,
    source: &Path,
    before: &Record,
    after: Option<&Value>,
) -> Result<()> {
    if before.kind != "scene" {
        return Ok(());
    }
    let policy = source.join("data/prompt-pinned-scenes.json");
    let pins: Value = if policy.is_file() {
        serde_json::from_slice(&std::fs::read(policy)?)?
    } else {
        serde_json::from_str(&connection.query_row::<String,_,_>("SELECT payload FROM content_records WHERE kind='document' AND id='prompt-pinned-scenes' AND deleted=0",[],|r|r.get(0))?)?
    };
    if !pins["scenes"].is_object() {
        return Err(ApiError::invalid("定稿保护基线无效"));
    }
    if pins["scenes"].get(&before.id).is_none() {
        return Ok(());
    }
    let after =
        after.ok_or_else(|| ApiError::invalid(format!("定稿场景不能下架：{}", before.id)))?;
    for field in [
        "prompt",
        "negative",
        "animaCaption",
        "recommendedSize",
        "rating",
        "mature",
    ] {
        if before.data.get(field) != after.get(field)
            && after.get(field) != pins["scenes"][&before.id].get(field)
        {
            return Err(ApiError::invalid(format!(
                "定稿保护拒绝修改 {}.{field}",
                before.id
            )));
        }
    }
    Ok(())
}
pub(super) fn relations(connection: &Connection) -> Result<()> {
    let missing: Option<String> = connection.query_row("SELECT kind||':'||id FROM content_records r WHERE deleted=0 AND kind IN('scene','blueprint','outfit') AND character_id<>'' AND character_id<>'triad' AND NOT EXISTS(SELECT 1 FROM content_records c WHERE c.kind='character' AND c.id=r.character_id AND c.deleted=0) LIMIT 1",[],|r|r.get(0)).optional()?;
    if let Some(id) = missing {
        return Err(ApiError::invalid(format!("人物关联不存在：{id}")));
    }
    let missing: Option<String> = connection.query_row("SELECT r.kind||':'||r.id FROM content_records r JOIN content_records c ON c.kind='character' AND c.id=r.character_id AND c.deleted=0 WHERE r.deleted=0 AND r.kind IN('blueprint','scene') AND json_type(c.payload,'$.popular')='object' AND COALESCE(json_extract(r.payload,'$.outfitId'),'')<>'' AND NOT EXISTS(SELECT 1 FROM content_records o WHERE o.kind='outfit' AND o.deleted=0 AND o.id=r.character_id||'/'||json_extract(r.payload,'$.outfitId')) LIMIT 1",[],|r|r.get(0)).optional()?;
    if let Some(id) = missing {
        return Err(ApiError::invalid(format!("服装关联不存在：{id}")));
    }
    let invalid: Option<String> = connection.query_row("SELECT c.id FROM content_records c WHERE c.kind='character' AND c.deleted=0 AND json_type(c.payload,'$.popular')='object' AND (SELECT count(*) FROM content_records o WHERE o.kind='outfit' AND o.deleted=0 AND o.character_id=c.id AND json_extract(o.payload,'$.outfit.default')=1)<>1 LIMIT 1",[],|r|r.get(0)).optional()?;
    if let Some(id) = invalid {
        return Err(ApiError::invalid(format!(
            "角色必须有且仅有一个默认服装：{id}"
        )));
    }
    Ok(())
}
