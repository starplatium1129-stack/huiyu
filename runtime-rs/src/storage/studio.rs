//! The workspace owns projects, durable frame slots and immutable media revisions.
mod restore;
mod video;
mod exports;
use super::records::json_column;
use super::*;
pub(super) use restore::restore_records;
use rusqlite::{OptionalExtension, Params, params};

fn text<'a>(item: &'a Value, field: &str, limit: usize, empty: bool) -> Result<&'a str> {
    item[field]
        .as_str()
        .filter(|s| {
            (empty || !s.trim().is_empty())
                && !s.contains('\0')
                && s.encode_utf16().count() <= limit
        })
        .ok_or_else(|| invalid("创作资料字段无效"))
}
fn id<'a>(item: &'a Value, key: &str) -> Result<&'a str> {
    text(item, key, 160, false)
}
fn positive(item: &Value, key: &str) -> Result<i64> {
    item[key]
        .as_i64()
        .filter(|n| (1..=9_007_199_254_740_991).contains(n))
        .ok_or_else(|| invalid("修订号无效"))
}
fn document(value: &Value, max: usize) -> Result<()> {
    if !value.is_null() && (!value.is_object() || serde_json::to_vec(value)?.len() > max) {
        return Err(invalid("创作记录无效或过大"));
    }
    Ok(())
}
fn check_kind(kind: &str, mime: &str) -> Result<()> {
    let valid = match kind {
        "audio" => mime == "audio/wav",
        "clip" => matches!(mime, "video/mp4" | "video/webm"),
        "character" | "outfit" | "expression" | "pose" | "scene" | "keyframe" => mime.starts_with("image/"),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid("素材种类与原件格式不一致"))
    }
}
fn source(value: &Value) -> Result<()> {
    match value["kind"].as_str() {
        Some("file") => {
            if value.get("name").is_some() {
                text(value, "name", 512, false)?;
            }
        }
        Some("artwork") => {
            if !value["artworkId"].is_number() {
                text(value, "artworkId", 256, false)?;
            }
        }
        Some("catalog") => {
            text(value, "catalogKind", 64, false)?;
            text(value, "catalogId", 256, false)?;
            if value.get("catalogRevision").is_some() && value["catalogRevision"].as_u64().is_none()
            {
                return Err(invalid("目录修订号无效"));
            }
        }
        Some("generation") => {
            text(value, "taskId", 256, false)?;
            for (field, min) in [("seed", 0), ("width", 1), ("height", 1)] {
                if let Some(number) = value.get(field)
                    && number.as_u64().is_none_or(|n| !(min..=9_007_199_254_740_991).contains(&n))
                {
                    return Err(invalid("生成种子或画幅无效"));
                }
            }
            if value["outputIndex"].as_u64().is_none() {
                return Err(invalid("生成结果编号无效"));
            }
            let refs = value["inputVersionIds"]
                .as_array()
                .filter(|refs| {
                    refs.len() <= 128
                        && refs
                            .iter()
                            .all(|r| r.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 640))
                })
                .ok_or_else(|| invalid("生成参考版本无效"))?;
            if let Some(origin) = value.get("keyframe") {
                let character = id(origin, "characterVersionId")?;
                if let Some(anchor) = origin.get("neutralAnchor")
                    && (anchor != true || refs.first().and_then(Value::as_str) != Some(character)
                        || origin.get("sceneVersionId").is_some())
                {
                    return Err(invalid("基准立绘来源无效"));
                }
                if origin.get("sceneVersionId").is_some() {
                    let scene = id(origin, "sceneVersionId")?;
                    if !refs.iter().any(|r| r.as_str() == Some(scene)) {
                        return Err(invalid("缺少场景空镜参考"));
                    }
                }
            }
            if value.get("modelId").is_some() {
                text(value, "modelId", 256, false)?;
            }
            if value.get("prompt").is_some() {
                text(value, "prompt", 32_768, true)?;
            }
        }
        _ => return Err(invalid("未知的素材来源")),
    }
    Ok(())
}
fn rows(c: &Context, query: &str, args: impl Params) -> Result<Vec<Value>> {
    Ok(c.db
        .prepare_cached(query)?
        .query_map(args, |row| json_column(row, 0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
fn find(c: &Context, table: &str, id: &str) -> Result<Option<Value>> {
    Ok(c.db
        .prepare_cached(&format!("SELECT body FROM {table} WHERE id=?"))?
        .query_row([id], |row| json_column(row, 0))
        .optional()?)
}
fn required(c: &Context, table: &str, id: &str) -> Result<Value> {
    find(c, table, id)?.ok_or_else(|| ApiError::new(404, "NOT_FOUND", "项目、镜头或素材版本已失效"))
}
fn check_revision(row: &Value, change: &Value) -> Result<i64> {
    let revision = positive(row, "revision")?;
    if change["expectedRevision"] != revision {
        return Err(conflict(
            "REVISION_CONFLICT",
            "资料已在另一处更改，请重新读取",
        ));
    }
    Ok(revision + 1)
}
fn frame(c: &Context, version: &Value) -> Result<()> {
    if version.is_null() {
        return Ok(());
    }
    let entry = required(
        c,
        "studio_versions",
        version.as_str().ok_or_else(|| invalid("帧版本无效"))?,
    )?;
    if entry["mime"]
        .as_str()
        .is_none_or(|s| !s.starts_with("image/"))
    {
        return Err(invalid("帧槽只接受图片"));
    }
    Ok(())
}
fn insert_shot(c: &Context, shot: &Value) -> Result<()> {
    id(shot, "id")?;
    id(shot, "projectId")?;
    text(shot, "title", 160, false)?;
    text(shot, "prompt", 32_768, true)?;
    positive(shot, "revision")?;
    let position = shot["position"]
        .as_i64()
        .filter(|i| *i >= 0)
        .ok_or_else(|| invalid("镜头位置无效"))?;
    document(&shot["legacy"], 65_536)?;
    frame(c, &shot["firstVersionId"])?;
    frame(c, &shot["lastVersionId"])?;
    version_mime(c, &shot["audioVersionId"], &["audio/wav"])?;
    version_mime(c, &shot["currentClipVersionId"], &["video/mp4","video/webm"])?;
    c.db.execute(
        "INSERT INTO studio_shots VALUES(?,?,?,?,?,?)",
        params![
            shot["id"].as_str(),
            shot["projectId"].as_str(),
            position,
            shot["firstVersionId"].as_str(),
            shot["lastVersionId"].as_str(),
            stringify(shot)
        ],
    )?;
    Ok(())
}
fn version_mime(c: &Context, key: &Value, accepted: &[&str]) -> Result<()> {
    if !key.is_null() {
        let version = required(c, "studio_versions", key.as_str().ok_or_else(|| invalid("素材版本无效"))?)?;
        if !version["mime"].as_str().is_some_and(|m| accepted.contains(&m)) {
            return Err(invalid("素材类型与分镜槽位不符"));
        }
    }
    Ok(())
}
fn origin_refs(c: &Context, origin: &Value) -> Result<()> {
    if let Some(values) = origin["inputVersionIds"].as_array() {
        for value in values {
            required(c, "studio_versions", value.as_str().ok_or_else(|| invalid("创作来源版本无效"))?)?;
        }
    }
    if origin["kind"] == "generation" && let Some(context) = origin.get("keyframe") {
        let character = required(c, "studio_versions", id(context, "characterVersionId")?)?;
        let asset = required(c, "studio_assets", id(&character, "assetId")?)?;
        if asset["kind"] != "character" || character["source"]["keyframe"]["neutralAnchor"] == true {
            return Err(invalid("请选择原始角色立绘"));
        }
        if context.get("sceneVersionId").is_some() {
            let scene = required(c, "studio_versions", id(context, "sceneVersionId")?)?;
            if required(c, "studio_assets", id(&scene, "assetId")?)?["kind"] != "scene" {
                return Err(invalid("请选择场景空镜"));
            }
        }
    }
    Ok(())
}
fn insert_version(c: &Context, version: &Value) -> Result<()> {
    let key = id(version, "id")?;
    let asset = required(c, "studio_assets", id(version, "assetId")?)?;
    let alias = text(version, "mediaAlias", 256, false)?;
    let media = c.lookup_media(alias)?;
    check_kind(string(&asset, "kind")?, &media.mime)?;
    if version["mime"] != media.mime
        || version["bytes"] != media.total_bytes
        || version["sha256"] != media.sha256
    {
        return Err(conflict("MEDIA_INVALID", "素材与工作区原件不一致"));
    }
    source(&version["source"])?;
    if version["source"]["keyframe"]["neutralAnchor"] == true && asset["kind"] != "character" {
        return Err(invalid("干净基准立绘必须保存为角色立绘"));
    }
    let number = positive(version, "number")?;
    c.db.execute(
        "INSERT INTO studio_versions VALUES(?,?,?,?,?)",
        params![key, asset["id"].as_str(), number, alias, stringify(version)],
    )?;
    c.db.execute(
        "INSERT INTO media_refs VALUES('studio-version',?,?)",
        params![key, media.sha256],
    )?;
    Ok(())
}
fn import_asset(c: &Context, data: &Value) -> Result<Value> {
    let key = id(data, "versionId")?;
    let asset_id = id(data, "assetId")?;
    let title = text(data, "title", 160, false)?;
    let kind = string(data, "kind")?;
    let origin = &data["source"];
    source(origin)?;
    let alias = text(data, "mediaAlias", 256, false)?;
    let media = c.lookup_media(alias)?;
    if data.get("sha256").is_some() && data["sha256"] != media.sha256 {
        return Err(conflict("MEDIA_INVALID", "原件摘要已变化"));
    }
    check_kind(kind, &media.mime)?;
    let version = if let Some(old) = find(c, "studio_versions", key)? {
        if old["assetId"] != asset_id || old["sha256"] != media.sha256 || old["source"] != *origin {
            return Err(conflict("VERSION_CONFLICT", "版本编号已用于其他原件或来源"));
        }
        old
    } else {
        origin_refs(c, origin)?;
        let number = match find(c, "studio_assets", asset_id)? {
            Some(mut asset) => {
                let revision = check_revision(&asset, data)?;
                if asset["kind"] != kind {
                    return Err(invalid("素材种类不能修改"));
                }
                asset["revision"] = revision.into();
                c.db.execute(
                    "UPDATE studio_assets SET body=? WHERE id=?",
                    params![stringify(&asset), asset_id],
                )?;
                revision
            }
            None if data["expectedRevision"] == 0 => {
                let asset = json!({"id":asset_id,"title":title,"kind":kind,"revision":1});
                c.db.execute(
                    "INSERT INTO studio_assets VALUES(?,?)",
                    params![asset_id, stringify(&asset)],
                )?;
                1
            }
            None => return Err(conflict("REVISION_CONFLICT", "原素材不存在")),
        };
        let version = json!({"id":key,"assetId":asset_id,"number":number,"mediaAlias":alias,"mime":media.mime,
            "bytes":media.total_bytes,"sha256":media.sha256,"source":origin});
        insert_version(c, &version)?;
        version
    };
    if data["consumeUpload"] == true {
        c.db.execute(
            "DELETE FROM media_refs WHERE owner_kind='temporary' AND owner_id=?",
            [alias],
        )?;
    }
    Ok(version)
}
fn change(c: &Context, data: &Value) -> Result<Value> {
    match data["action"].as_str() {
        Some("createProject") => {
            let key = id(data, "id")?;
            let title = text(data, "title", 160, false)?;
            let project = json!({"id":key,"title":title,"revision":1,"workbench":null});
            c.db.execute(
                "INSERT INTO studio_projects VALUES(?,?)",
                params![key, stringify(&project)],
            )?;
            Ok(project)
        }
        Some("saveWorkbench") => {
            let key = id(data, "id")?;
            let mut project = required(c, "studio_projects", key)?;
            let revision = check_revision(&project, data)?;
            document(&data["workbench"], 262_144)?;
            project["revision"] = revision.into();
            project["workbench"] = data["workbench"].clone();
            c.db.execute(
                "UPDATE studio_projects SET body=? WHERE id=?",
                params![stringify(&project), key],
            )?;
            Ok(project)
        }
        Some("createShot") => {
            let project = id(data, "projectId")?;
            let key = id(data, "id")?;
            if let Some(previous) = find(c, "studio_shots", key)? {
                if previous["projectId"] == project {
                    return Ok(previous);
                }
                return Err(conflict("SHOT_CONFLICT", "镜头编号已用于其他项目"));
            }
            required(c, "studio_projects", project)?;
            let position: i64 = c.db.query_row(
                "SELECT COALESCE(MAX(position)+1,0) FROM studio_shots WHERE project_id=?",
                [project],
                |r| r.get(0),
            )?;
            let mut shot = json!({"id":key,"projectId":project,"position":position,"title":data["title"],"prompt":data["prompt"],
                "revision":1,"firstVersionId":data["firstVersionId"],"lastVersionId":null,
                "currentClipVersionId":null,"audioVersionId":data["audioVersionId"]});
            if !data["legacy"].is_null() {
                shot["legacy"] = data["legacy"].clone();
            }
            insert_shot(c, &shot)?;
            Ok(shot)
        }
        Some("updateShot") => {
            let key = id(data, "id")?;
            let mut shot = required(c, "studio_shots", key)?;
            let revision = check_revision(&shot, data)?;
            for field in ["title", "prompt", "firstVersionId", "lastVersionId", "audioVersionId"] {
                if let Some(value) = data.get(field) {
                    match field {
                        "title" => {
                            text(data, field, 160, false)?;
                        }
                        "prompt" => {
                            text(data, field, 32_768, true)?;
                        }
                        "audioVersionId" => version_mime(c, value, &["audio/wav"])?,
                        _ => frame(c, value)?,
                    }
                    shot[field] = value.clone();
                }
            }
            shot["revision"] = revision.into();
            c.db.execute(
                "UPDATE studio_shots SET first_version=?,last_version=?,body=? WHERE id=?",
                params![
                    shot["firstVersionId"].as_str(),
                    shot["lastVersionId"].as_str(),
                    stringify(&shot),
                    key
                ],
            )?;
            Ok(shot)
        }
        Some("importAsset") => import_asset(c, data),
        _ => Err(invalid("未知的创作操作")),
    }
}
pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    if command["kind"].as_str().is_some_and(|key| key.starts_with("studio.export")) {
        return exports::execute(c, principal, command);
    }
    if command["kind"].as_str().is_some_and(|key| key.starts_with("studio.video")) {
        return video::execute(c, principal, command);
    }
    match command["kind"].as_str() {
        Some("studio.list") => {
            Ok(rows(c, "SELECT body FROM studio_projects ORDER BY rowid", [])?.into())
        }
        Some("studio.get") => {
            let key = id(command, "id")?;
            Ok(json!({"project":required(c,"studio_projects",key)?,
                "shots":rows(c,"SELECT body FROM studio_shots WHERE project_id=? ORDER BY position",[key])?,
                "assets":rows(c,"SELECT body FROM studio_assets ORDER BY rowid",[])?,
                "versions":rows(c,"SELECT body FROM studio_versions ORDER BY asset_id,number",[])?}))
        }
        Some("studio.write") => {
            text(command, "operationId", 200, false)?;
            c.transaction(|c| {
                let (op, previous) = c.start_operation(principal, command)?;
                if let Some(receipt) = previous { return Ok(receipt); }
                let result = change(c,&command["change"])?;
                let receipt = json!({"operationId":command["operationId"],"kind":"studio.write","revision":c.next_revision()?,"result":result});
                c.commit_operation(&op,&receipt)?;
                Ok(receipt)
            })
        }
        _ => Err(invalid("未知的创作工作区命令")),
    }
}
