use super::*;
pub(super) fn manifest(value: &Value) -> Result<Vec<Value>> {
    if !value.is_object() {
        return Err(failure(vec!["manifest 必须是解析对象".into()]));
    }
    let Some(files) = value["files"].as_array() else {
        return Err(failure(vec!["manifest.files 必须是数组".into()]));
    };
    let mut problems = Vec::new();
    let mut entries = Vec::new();
    let mut names = HashMap::new();
    let mut franchises = HashSet::new();
    for (index, entry) in files.iter().enumerate() {
        let at = format!("manifest.files[{index}]");
        if !entry.is_object() {
            problems.push(format!("{at} 必须是对象"));
            continue;
        }
        let Some(file) = entry["file"].as_str().filter(|name| safe_name(name)) else {
            problems.push(format!("{at} 的 file 不是安全的分片 JSON 基名（拒绝 traversal/绝对路径/分隔符/manifest.json/Windows 保留设备名）: {}",quoted(entry.get("file"))));
            continue;
        };
        let lower = file.to_ascii_lowercase();
        if let Some(previous) = names.get(&lower) {
            problems.push(format!(
                "{at} 的 file 与 {previous} 在 Windows 大小写不敏感下视为同一文件，冲突: {file}"
            ));
            continue;
        }
        names.insert(lower, at.clone());
        let Some(franchise) = entry["franchise"].as_str().filter(|s| !s.trim().is_empty()) else {
            problems.push(format!("{at} 缺少非空 franchise 字符串"));
            continue;
        };
        if !franchises.insert(franchise) {
            problems.push(format!(
                "{at} 的 franchise 重复声明（同一 franchise 不得挂在多个文件上）: {franchise}"
            ));
            continue;
        }
        entries.push(entry.clone());
    }
    if problems.is_empty() {
        Ok(entries)
    } else {
        Err(failure(problems))
    }
}
pub(super) fn shards(value: &Value, entries: &[Value]) -> Result<HashMap<String, Value>> {
    let Some(provided) = value.as_object() else {
        return Err(failure(vec![
            "shards 必须是「分片文件名 → { text, data }」的 Map 或普通对象".into(),
        ]));
    };
    let mut output = HashMap::new();
    let mut ids = HashMap::new();
    let mut problems = Vec::new();
    for entry in entries {
        let file = entry["file"].as_str().unwrap();
        let Some(shard) = provided.get(file).filter(|v| v.is_object()) else {
            problems.push(format!(
                "来源分片不齐全：缺少 {} 的 {{ text, data }}",
                js(&json!(file))
            ));
            continue;
        };
        let Some(text) = shard["text"].as_str() else {
            problems.push(format!("分片 {file} 缺少原始文本 text"));
            continue;
        };
        let data = &shard["data"];
        if !data.is_object() {
            problems.push(format!("分片 {file} 缺少解析对象 data"));
            continue;
        }
        let parsed = match serde_json::from_str::<Value>(text) {
            Ok(value) => value,
            Err(error) => {
                problems.push(format!("分片 {file} 的 text 不是合法 JSON: {error}"));
                continue;
            }
        };
        if !same(&parsed, data) {
            problems.push(format!(
                "分片 {file} 的 text 与 data 不一致（data 必须等于 JSON.parse(text)）"
            ));
            continue;
        }
        let Some(blueprints) = data["blueprints"].as_array() else {
            problems.push(format!("分片 {file} 的根必须是 {{ blueprints: [...] }}"));
            continue;
        };
        if data["franchise"] != entry["franchise"] {
            problems.push(format!("分片 {file} 的 franchise 与 manifest 声明冲突（不静默合并）: 分片为 {}，manifest 为 {}",quoted(data.get("franchise")),js(&entry["franchise"])));
            continue;
        }
        let mut valid = true;
        for (index, blueprint) in blueprints.iter().enumerate() {
            let Some(id) = blueprint["id"].as_str().filter(|id| !id.trim().is_empty()) else {
                problems.push(format!("分片 {file} 第 {index} 个蓝图缺少非空字符串 id"));
                valid = false;
                continue;
            };
            if let Some(previous) = ids.get(id) {
                problems.push(format!("蓝图 id {id} 同时出现在 {previous} 和 {file}"));
                valid = false;
                continue;
            }
            ids.insert(id.to_string(), file.to_string());
        }
        if valid {
            output.insert(file.into(), shard.clone());
        }
    }
    for file in provided.keys() {
        if !entries.iter().any(|entry| entry["file"] == *file) {
            problems.push(format!(
                "shards 包含未在 manifest 声明的分片: {}",
                js(&json!(file))
            ));
        }
    }
    if problems.is_empty() {
        Ok(output)
    } else {
        Err(failure(problems))
    }
}
pub(super) fn target(value: &Value, mapping: &Value) -> Result<Vec<(String, Vec<Value>)>> {
    let mut problems = Vec::new();
    let usable = mapping.is_object();
    if !usable {
        problems
            .push("franchiseByCharacter 必须是「characterId → franchise」的 Map 或普通对象".into());
    }
    let Some(values) = value.as_array() else {
        problems.push("目标 blueprints 必须是数组".into());
        return Err(failure(problems));
    };
    if values.is_empty() {
        problems.push("目标 blueprints 为空：全部 franchise 都会被删除并产生空 manifest，而当前读取器（blueprint-store 的 readManifest）不接受空清单，请保留至少一个蓝图".into());
        return Err(failure(problems));
    }
    let (mut groups, mut positions, mut ids) = (
        Vec::<(String, Vec<Value>)>::new(),
        HashMap::<String, usize>::new(),
        HashMap::new(),
    );
    for (index, blueprint) in values.iter().enumerate() {
        let at = format!("目标 blueprints[{index}]");
        if !blueprint.is_object() {
            problems.push(format!("{at} 必须是对象"));
            continue;
        }
        let Some(id) = blueprint["id"].as_str().filter(|id| !id.trim().is_empty()) else {
            problems.push(format!("{at} 缺少非空字符串 id"));
            continue;
        };
        if let Some(previous) = ids.get(id) {
            problems.push(format!("{at} 的蓝图 id 重复: {id}（已出现在 {previous}）"));
            continue;
        }
        ids.insert(id, at.clone());
        if !usable {
            continue;
        }
        let Some(character) = blueprint["characterId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
        else {
            problems.push(format!("蓝图 {id}（{at}）缺少非空字符串 characterId"));
            continue;
        };
        let Some(mapped) = mapping.get(character) else {
            problems.push(format!("蓝图 {id} 的 characterId {} 不在角色→franchise 映射中（未知角色，不自动归入 unknown 建片）",js(&json!(character))));
            continue;
        };
        let Some(franchise) = mapped
            .as_str()
            .filter(|f| !f.trim().is_empty() && !f.trim().eq_ignore_ascii_case("unknown"))
        else {
            problems.push(format!("蓝图 {id} 的 characterId {} 无法确认 franchise（映射值为空或 unknown，不自动建 unknown 片）",js(&json!(character))));
            continue;
        };
        let position = *positions.entry(franchise.into()).or_insert_with(|| {
            let position = groups.len();
            groups.push((franchise.into(), Vec::new()));
            position
        });
        groups[position].1.push(blueprint.clone());
    }
    if problems.is_empty() {
        Ok(groups)
    } else {
        Err(failure(problems))
    }
}
pub fn collection(items: &Value) -> Result<&Vec<Value>> {
    let items = items
        .as_array()
        .filter(|items| items.len() <= 2000)
        .ok_or_else(|| Error::invalid("蓝图 数据格式或数量超出限制"))?;
    let mut ids = HashSet::new();
    for item in items {
        let id = item["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| Error::invalid("蓝图 ID 必须非空且唯一"))?;
        if !ids.insert(id) {
            return Err(Error::invalid(format!("蓝图 ID 必须非空且唯一：{id}")));
        }
        for field in ["characterId", "title"] {
            if item[field].as_str().is_none_or(|s| s.trim().is_empty()) {
                return Err(Error::invalid(format!("蓝图缺少 {field}：{id}")));
            }
        }
        if !item["promptTokens"].is_array() || !item["negativeTokens"].is_array() {
            return Err(Error::invalid(format!(
                "蓝图 promptTokens/negativeTokens 必须为数组：{id}"
            )));
        }
        if !item["promptProse"].is_string() {
            return Err(Error::invalid(format!("蓝图缺少 promptProse：{id}")));
        }
    }
    Ok(items)
}
pub fn changed(current: &[Value], change: &Value) -> Result<Vec<Value>> {
    if !change.is_object()
        || change
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !matches!(key.as_str(), "upsert" | "remove"))
    {
        return Err(Error::invalid("蓝图 变更集格式错误"));
    }
    let updates = collection(&change["upsert"])?;
    let removed = change["remove"]
        .as_array()
        .filter(|a| a.len() <= 2000)
        .ok_or_else(|| Error::invalid("蓝图 remove 必须为 ID 数组"))?;
    let ids = current
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect::<HashSet<_>>();
    let updates = updates
        .iter()
        .map(|item| (item["id"].as_str().unwrap(), item))
        .collect::<HashMap<_, _>>();
    let mut remove = HashSet::new();
    for id in removed {
        let id = id
            .as_str()
            .ok_or_else(|| Error::invalid("蓝图 删除 ID 无效"))?;
        if !ids.contains(id) || !remove.insert(id) || updates.contains_key(id) {
            return Err(Error::invalid(format!(
                "蓝图 删除 ID 不存在、重复或同时更新：{id}"
            )));
        }
    }
    let mut result = current
        .iter()
        .filter(|item| !remove.contains(item["id"].as_str().unwrap_or("")))
        .map(|item| {
            updates
                .get(item["id"].as_str().unwrap_or(""))
                .copied()
                .unwrap_or(item)
                .clone()
        })
        .collect::<Vec<_>>();
    result.extend(
        change["upsert"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| !ids.contains(item["id"].as_str().unwrap()))
            .cloned(),
    );
    collection(&json!(result))?;
    Ok(result)
}
