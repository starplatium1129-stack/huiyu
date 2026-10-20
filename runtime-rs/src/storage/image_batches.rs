use super::*;
use rusqlite::{OptionalExtension, params};

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    if kind == "imageBatch.list" {
        let mut statement = c.db.prepare("SELECT body,revision FROM image_batch_plans WHERE principal=? AND (json_extract(body,'$.state')='running' OR EXISTS(SELECT 1 FROM json_each(body,'$.jobs') j WHERE json_extract(j.value,'$.status') IN ('accepted','running'))) ORDER BY revision LIMIT 100")?;
        return Ok(Value::Array(statement.query_map([principal], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
            .map(|row| { let (body, revision) = row?; let mut value: Value = serde_json::from_str(&body)?; value["revision"] = json!(revision); Ok(value) })
            .collect::<Result<Vec<_>>>()?));
    }
    let id = string(command, "id")?;
    if uuid::Uuid::parse_str(id).is_err() { return Err(invalid("Invalid image batch identity")); }
    if kind == "imageBatch.get" { return read(c, principal, id); }
    c.writer()?;
    c.transaction(|c| {
        let mut plan = read(c, principal, id)?;
        if kind == "imageBatch.create" {
            if !plan.is_null() {
                if plan["source"] != command["plan"] { return Err(conflict("BATCH_KEY_CONFLICT", "Batch identity belongs to another plan")); }
                return Ok(plan);
            }
            let source = &command["plan"];
            if source["version"] != 1 || source["runtimeOwned"] != true || source["engine"] != "anima"
                || source["createdAt"].as_u64().is_none()
                || source["owner"]["kind"] != "workspace" || source["owner"]["workspaceId"] != c.workspace_id
                || source["owner"]["principalId"] != principal {
                return Err(invalid("Invalid batch workspace or version"));
            }
            let targets = source["targets"].as_array().ok_or_else(|| invalid("Missing batch targets"))?;
            let mut target_ids = std::collections::HashSet::new();
            for target in targets {
                if !target["id"].as_str().is_some_and(|id| !id.is_empty() && target_ids.insert(id))
                    || !target["title"].is_string() || !matches!(target["kind"].as_str(),Some("scene"|"character")) {
                    return Err(invalid("Invalid batch target"));
                }
            }
            let jobs = source["jobs"].as_array().filter(|jobs| !jobs.is_empty() && jobs.len() <= 200).ok_or_else(|| invalid("A batch must contain 1–200 images"))?;
            let mut keys = std::collections::HashSet::new();
            let mut job_ids = std::collections::HashSet::new();
            for job in jobs {
                if !job["requestKey"].as_str().is_some_and(|key| !key.is_empty() && key.len() <= 160 && keys.insert(key))
                    || !job["id"].as_str().is_some_and(|id| uuid::Uuid::parse_str(id).is_ok() && job_ids.insert(id))
                    || !job["sceneId"].as_str().is_some_and(|id| target_ids.contains(id))
                    || job["seed"].as_i64().is_none() || !job["variant"].as_u64().is_some_and(|index| index < 3)
                    || !matches!(job["snapshot"]["engine"].as_str(), Some("anima" | "krea2"))
                    || !job["taskInput"].is_object() || !job["snapshot"]["context"].is_object()
                    || job["submitted"] != false || job["status"] != "pending" {
                    return Err(invalid("Invalid frozen image batch item"));
                }
            }
            plan = source.clone();
            plan["source"] = source.clone();
            plan["id"] = json!(id);
            plan["state"] = json!("running");
        } else {
            if plan.is_null() { return Err(ApiError::new(404, "BATCH_NOT_FOUND", "Image batch does not exist")); }
            if kind == "imageBatch.control" {
                match command["action"].as_str() {
                    Some("pause") => { plan["state"] = json!("paused"); }
                    Some("resume" | "retry") => {
                        if command["action"] == "retry" {
                            for job in plan["jobs"].as_array_mut().unwrap() {
                                if matches!(job["status"].as_str(), Some("failed" | "cancelled")) {
                                    job["requestKey"] = json!(uuid::Uuid::new_v4().to_string());
                                    job.as_object_mut().unwrap().remove("taskId"); job["status"] = json!("pending");
                                    job["error"] = Value::Null; job["submitted"] = json!(false);
                                }
                            }
                        }
                        plan["state"] = json!("running"); plan["error"] = Value::Null;
                    }
                    _ => return Err(invalid("Unknown batch action")),
                }
            } else if kind == "imageBatch.progress" {
                if command["expectedRevision"] != plan["revision"] { return Err(conflict("REVISION_CONFLICT", "Image batch changed")); }
                let mut changed = false;
                if let Some(index) = command["index"].as_u64() {
                    let job = plan["jobs"].as_array_mut().and_then(|jobs| jobs.get_mut(index as usize)).ok_or_else(|| invalid("Invalid batch index"))?;
                    for key in ["taskId","status","error","historyId","imageId","submitted","message"] {
                        if let Some(value) = command["patch"].get(key) {
                            if &job[key] != value { job[key] = value.clone(); changed = true; }
                        }
                    }
                }
                if let Some(state) = command.get("state") { if &plan["state"] != state { plan["state"] = state.clone(); changed = true; } }
                if let Some(error) = command.get("error") { if &plan["error"] != error { plan["error"] = error.clone(); changed = true; } }
                if !changed { return Ok(plan); }
            } else { return Err(invalid("Unknown image batch command")); }
        }
        let revision = c.next_revision()?;
        plan["revision"] = json!(revision);
        let written = c.db.execute("INSERT INTO image_batch_plans VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision WHERE image_batch_plans.principal=excluded.principal",
            params![id, principal, stringify(&plan), revision])?;
        if written != 1 { return Err(conflict("BATCH_KEY_CONFLICT","Batch identity is already in use")); }
        Ok(plan)
    })
}

fn read(c: &Context, principal: &str, id: &str) -> Result<Value> {
    let body: Option<String> = c.db.query_row("SELECT body FROM image_batch_plans WHERE id=? AND principal=?", params![id,principal], |row| row.get(0)).optional()?;
    body.map(|body| serde_json::from_str(&body).map_err(Into::into)).transpose().map(|value| value.unwrap_or(Value::Null))
}
