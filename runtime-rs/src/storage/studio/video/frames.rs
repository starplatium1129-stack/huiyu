use super::*;

pub(super) fn plan(
    c: &Context,
    choice: &Choice,
    settings: &Value,
    shot: &Value,
    run_id: &str,
) -> Result<Value> {
    let mut missing = Vec::new();
    if shot["firstVersionId"].is_null() {
        missing.push("first");
    }
    if settings["mode"] == "first-last" && shot["lastVersionId"].is_null() {
        missing.push("last");
    }
    if missing.is_empty() {
        return Ok(Value::Null);
    }
    let plan = choice
        .frame_plan
        .as_ref()
        .ok_or_else(|| invalid("镜头缺帧，请先绑定原图或选用补帧参考图"))?;
    if !matches!(
        plan.model_id.as_str(),
        "flux-kontext-dev" | "minimax-h3-image-q4"
    ) || !(1..=4).contains(&plan.reference_version_ids.len())
    {
        return Err(invalid("请为缺帧选择本机关键帧模型和 1 到 4 张有序参考图"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut media = Vec::new();
    for source in &plan.reference_version_ids {
        if !seen.insert(source) {
            return Err(invalid("同一图片版本不能重复用作补帧参考"));
        }
        let file = reference(c, &json!(source))?;
        if file["bytes"].as_u64().unwrap_or(u64::MAX) > 16 * 1024 * 1024 {
            return Err(invalid("补帧参考图须小于或等于 16 MiB"));
        }
        media.push(file);
    }
    let (width, height) = match plan.canvas.as_deref().unwrap_or("landscape") {
        "landscape" => (768, 512),
        "portrait" => (512, 768),
        "square" => (768, 768),
        _ => return Err(invalid("关键帧画幅无效")),
    };
    let mut tasks = Vec::new();
    for slot in missing {
        let (explicit, default, offset) = if slot == "first" {
            (&plan.first_prompt, "画出这个动作开始前的首帧。", 0)
        } else {
            (&plan.last_prompt, "画出这个动作完成后的尾帧。", 1)
        };
        let prompt = match explicit.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(text) => text.to_owned(),
            None => format!("{}\n{default}", settings["prompt"].as_str().unwrap_or("")),
        };
        if prompt.contains('\0') || prompt.encode_utf16().count() > 4000 {
            return Err(invalid("合并后的补帧指令最多 4000 字符"));
        }
        let seed = (settings["seed"].as_u64().unwrap_or(0) + offset) & 0x7fff_ffff;
        let key = format!("studio-frame-{run_id}-{slot}");
        tasks.push(json!({"slot":slot,"status":"queued","taskId":null,"requestKey":key,"versionId":key,"seed":seed,"prompt":prompt}));
    }
    Ok(
        json!({"modelId":plan.model_id,"referenceVersionIds":plan.reference_version_ids,"referenceMedia":media,
        "width":width,"height":height,"bindRevision":choice.expected_revision,"state":"queued","tasks":tasks}),
    )
}

pub(super) fn advance(c: &mut Context, principal: &str, cmd: &Value) -> Result<Value> {
    let mut run = one(c, principal, id(cmd, "id")?)?;
    if finished(&run) {
        return Ok(run);
    }
    let slot = string(cmd, "slot")?;
    let index = run["preparation"]["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().position(|t| t["slot"] == slot))
        .ok_or_else(|| invalid("找不到补帧槽位"))?;
    let task = &run["preparation"]["tasks"][index];
    if task["status"] == "succeeded" {
        return Ok(run);
    }
    let status = string(cmd, "status")?;
    if !matches!(
        status,
        "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"
    ) {
        return Err(invalid("补帧状态无效"));
    }
    if status == "succeeded" {
        let prep = &run["preparation"];
        let task_id = id(cmd, "taskId")?;
        let output:Value=c.db.query_row("SELECT o.media_json FROM task_outputs o JOIN tasks t USING(task_id) WHERE t.task_id=? AND t.principal_id=? AND t.request_key=? AND o.output_index=0 AND o.committed=1",
            params![task_id,principal,string(task,"requestKey")?],|r|json_column(r,0)).optional()?.ok_or_else(||conflict("TASK_RESULT_MISSING","关键帧仍在写入工作区"))?;
        let version = id(task, "versionId")?.to_owned();
        let title = run["shotTitle"]
            .as_str()
            .unwrap_or("分镜")
            .chars()
            .take(65)
            .collect::<String>();
        let name = if slot == "first" { "首帧" } else { "尾帧" };
        let source = json!({"kind":"generation","taskId":task_id,"outputIndex":0,"inputVersionIds":prep["referenceVersionIds"],
            "modelId":prep["modelId"],"seed":task["seed"],"prompt":task["prompt"],"width":prep["width"],"height":prep["height"]});
        import_asset(
            c,
            &json!({"assetId":version,"versionId":version,"title":format!("{title} · {name}"),"kind":"keyframe","expectedRevision":0,
            "source":source,"mediaAlias":output["alias"],"sha256":output["sha256"]}),
        )?;
        let version_field = if slot == "first" {
            "firstVersionId"
        } else {
            "lastVersionId"
        };
        let frame_field = if slot == "first" {
            "firstRef"
        } else {
            "lastRef"
        };
        let shot = required(c, "studio_shots", id(&run, "shotId")?)?;
        // Filling an empty slot must never replace a later edit in another window.
        if run["cancelRequested"] != true
            && shot["revision"] == prep["bindRevision"]
            && shot[version_field].is_null()
        {
            let mut edit =
                json!({"action":"updateShot","id":shot["id"],"expectedRevision":shot["revision"]});
            edit[version_field] = json!(version);
            let bound = change(c, &edit)?;
            run["preparation"]["bindRevision"] = bound["revision"].clone();
        }
        run[version_field] = json!(version);
        run[frame_field] = reference(c, &run[version_field])?;
        c.next_revision()?;
    }
    let row = &mut run["preparation"]["tasks"][index];
    row["status"] = json!(status);
    if let Some(task) = cmd.get("taskId").filter(|v| !v.is_null()) {
        row["taskId"] = task.clone();
    }
    if let Some(message) = cmd["error"].as_str() {
        row["error"] = message.into();
    }
    if let Some(data) = cmd.get("telemetry") {
        row["telemetry"] = data.clone();
    }
    let ready = run["preparation"]["tasks"]
        .as_array()
        .is_some_and(|tasks| tasks.iter().all(|r| r["status"] == "succeeded"));
    run["preparation"]["state"] = if ready { "ready" } else { "generating" }.into();
    save(c, &run, false)?;
    Ok(run)
}
