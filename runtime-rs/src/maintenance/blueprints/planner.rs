use super::*;
fn write(file: &str, franchise: &str, group: &[Value], kind: &str) -> Value {
    let data = json!({"version":2,"franchise":franchise,"blueprints":group});
    json!({"file":file,"franchise":franchise,"count":group.len(),"kind":kind,"text":json_text(&data),"data":data})
}
pub fn plan(input: &Value) -> Result<Value> {
    if !input.is_object() {
        return Err(failure(vec![
            "planBlueprintChanges 的输入必须是单个对象参数".into(),
        ]));
    }
    let manifest = &input["manifest"];
    let entries = validate::manifest(manifest)?;
    let shards = validate::shards(&input["shards"], &entries)?;
    let groups = validate::target(&input["blueprints"], &input["franchiseByCharacter"])?;
    let lookup = groups
        .iter()
        .map(|(franchise, group)| (franchise.as_str(), group))
        .collect::<HashMap<_, _>>();
    let known = entries
        .iter()
        .map(|entry| entry["franchise"].as_str().unwrap())
        .collect::<HashSet<_>>();
    let occupied = entries
        .iter()
        .map(|entry| entry["file"].as_str().unwrap().to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let (mut files, mut writes, mut deletes, mut unchanged) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut problems = Vec::new();
    for entry in &entries {
        let file = entry["file"].as_str().unwrap();
        let franchise = entry["franchise"].as_str().unwrap();
        let Some(group) = lookup.get(franchise) else {
            deletes.push(json!({"file":file,"franchise":franchise}));
            continue;
        };
        let mut next = entry.clone();
        next["count"] = json!(group.len());
        files.push(next);
        if same(&shards[file]["data"]["blueprints"], &json!(group)) {
            unchanged.push(json!({"file":file,"franchise":franchise,"count":group.len()}));
        } else {
            writes.push(write(file, franchise, group, "update"));
        }
    }
    let mut new_names = HashSet::new();
    for (franchise, group) in &groups {
        if known.contains(franchise.as_str()) {
            continue;
        }
        let slug = franchise_slug(franchise);
        let file = format!("{slug}.json");
        if slug == "unknown" {
            problems.push(format!("新 franchise {} 无法生成有效分片文件名（slug 退化为 unknown），不自动归入 unknown 建片",js(&json!(franchise))));
        } else if reserved(&slug) {
            problems.push(format!(
                "新 franchise {} 的文件名 {file} 是 Windows 保留设备名",
                js(&json!(franchise))
            ));
        } else if file == "manifest.json" {
            problems.push(format!(
                "新 franchise {} 的文件名 {file} 与 manifest 本身冲突",
                js(&json!(franchise))
            ));
        } else if occupied.contains(&file) || !new_names.insert(file.clone()) {
            problems.push(format!("新 franchise {} 的文件名 {file} 与现有分片或其他新系列冲突（含本次将被删除的文件名；如需复用同名文件请分两次保存）",js(&json!(franchise))));
        } else {
            files.push(json!({"file":file,"franchise":franchise,"count":group.len()}));
            writes.push(write(&file, franchise, group, "create"));
        }
    }
    if !problems.is_empty() {
        return Err(failure(problems));
    }
    let aggregate = files
        .iter()
        .flat_map(|entry| lookup[entry["franchise"].as_str().unwrap()].iter().cloned())
        .collect::<Vec<_>>();
    let mut next = manifest.clone();
    next["files"] = json!(files);
    let changed = !same(&next, manifest);
    let aggregate = json!({"version":2,"blueprints":aggregate});
    Ok(
        json!({"manifest":{"data":next,"text":json_text(&next),"changed":changed},"aggregate":{"data":aggregate,"text":json_text(&aggregate)},"summary":{"writes":writes.len(),"deletes":deletes.len(),"unchanged":unchanged.len(),"blueprints":aggregate["blueprints"].as_array().unwrap().len(),"franchises":files.len()},"dirty":!writes.is_empty()||!deletes.is_empty()||changed,"writes":writes,"deletes":deletes,"unchanged":unchanged}),
    )
}
