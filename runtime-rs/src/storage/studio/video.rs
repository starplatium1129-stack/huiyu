use super::*;
mod frames;
use crate::studio_workflows::{Choice, Template};

fn not_found() -> ApiError {
    ApiError::new(404, "STUDIO_VIDEO_NOT_FOUND", "找不到当前项目中的镜头任务")
}
fn one(c: &Context, principal: &str, key: &str) -> Result<Value> {
    c.db.query_row(
        "SELECT body FROM studio_video_runs WHERE id=? AND principal=?",
        params![key, principal],
        |r| json_column(r, 0),
    )
    .optional()?
    .ok_or_else(not_found)
}
fn save(c: &Context, run: &Value, done: bool) -> Result<()> {
    c.db.execute(
        "UPDATE studio_video_runs SET body=?,done=? WHERE id=?",
        params![stringify(run), done, id(run, "id")?],
    )?;
    Ok(())
}
fn finished(run: &Value) -> bool {
    matches!(
        run["status"].as_str(),
        Some("succeeded" | "failed" | "cancelled" | "interrupted")
    )
}
fn reference(c: &Context, slot: &Value) -> Result<Value> {
    let version = required(
        c,
        "studio_versions",
        slot.as_str()
            .ok_or_else(|| invalid("请先将参考图绑定到分镜槽位"))?,
    )?;
    if !matches!(
        version["mime"].as_str(),
        Some("image/png" | "image/jpeg" | "image/webp")
    ) || version["bytes"]
        .as_u64()
        .is_none_or(|n| n > 20 * 1024 * 1024)
    {
        return Err(invalid("视频帧请绑定 20 MiB 以内的 PNG、JPEG 或 WebP 原图"));
    }
    Ok(
        json!({"mediaAlias":version["mediaAlias"],"sha256":version["sha256"],"bytes":version["bytes"]}),
    )
}
fn enqueue(c: &mut Context, principal: &str, cmd: &Value) -> Result<Value> {
    let project = id(cmd, "projectId")?;
    let batch = id(cmd, "batchId")?;
    let fingerprint = canonical::fingerprint(&cmd["request"]);
    if let Some((p, owner, hash)) =
        c.db.query_row(
            "SELECT project_id,principal,fingerprint FROM studio_video_batches WHERE id=?",
            [batch],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
    {
        if p != project || owner != principal || hash != fingerprint {
            return Err(conflict(
                "STUDIO_BATCH_CONFLICT",
                "这个批次编号已用于不同的镜头设置",
            ));
        }
        return Ok(Value::Null);
    }
    required(c, "studio_projects", project)?;
    let shots = cmd["request"]["shots"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(|| invalid("一次请选择 1 到 64 个镜头"))?;
    let templates: Vec<Template> = serde_json::from_value(cmd["templates"].clone())?;
    c.db.execute(
        "INSERT INTO studio_video_batches VALUES(?,?,?,?)",
        params![batch, project, principal, fingerprint],
    )?;
    for raw in shots {
        let choice: Choice =
            serde_json::from_value(raw.clone()).map_err(|_| invalid("镜头导演设置字段无效"))?;
        let shot = required(c, "studio_shots", &choice.shot_id)?;
        if shot["projectId"] != project {
            return Err(not_found());
        }
        if shot["revision"] != choice.expected_revision {
            return Err(conflict(
                "REVISION_CONFLICT",
                "首尾帧或镜头描述已改变，请刷新后重新选择",
            ));
        }
        if c.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM studio_video_runs WHERE shot_id=? AND done=0)",
            [&choice.shot_id],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(conflict("STUDIO_SHOT_BUSY", "这个镜头已经在队列中"));
        }
        let (settings, input, template) = choice.compile(&templates, &shot)?;
        let audio = if settings["mode"] == "dialogue" {
            let version = required(
                c,
                "studio_versions",
                shot["audioVersionId"]
                    .as_str()
                    .ok_or_else(|| invalid("请先绑定角色配音"))?,
            )?;
            if version["mime"] != "audio/wav"
                || version["bytes"]
                    .as_u64()
                    .is_none_or(|n| n == 0 || n > 20 * 1024 * 1024)
            {
                return Err(invalid("对白配音需要 20 MiB 以内的 WAV"));
            }
            json!({"mediaAlias":version["mediaAlias"],"sha256":version["sha256"],"bytes":version["bytes"]})
        } else {
            Value::Null
        };
        let key = uuid::Uuid::new_v4().to_string();
        let preparation = frames::plan(c, &choice, &settings, &shot, &key)?;
        let first_ref = if shot["firstVersionId"].is_null() {
            Value::Null
        } else {
            reference(c, &shot["firstVersionId"])?
        };
        let last = if settings["mode"] == "first-last" {
            shot["lastVersionId"].clone()
        } else {
            Value::Null
        };
        let last_ref = if !last.is_null() {
            reference(c, &last)?
        } else {
            Value::Null
        };
        let created = now();
        let run = json!({"id":key,"projectId":project,"batchId":batch,"shotId":choice.shot_id,"shotTitle":shot["title"],
            "shotRevision":choice.expected_revision,"firstVersionId":shot["firstVersionId"],"lastVersionId":last,
            "audioVersionId":if audio.is_null(){Value::Null}else{shot["audioVersionId"].clone()},"audioRef":audio,
            "firstRef":first_ref,"lastRef":last_ref,"input":input,"settings":settings,"preparation":preparation,
            "templateId":template["id"],"templateVersion":template["version"],"templateSha256":template["sha256"],
            "status":"queued","taskId":null,"clipVersionId":null,"createdAt":created,"cancelRequested":false});
        c.db.execute("INSERT INTO studio_video_runs(id,batch_id,project_id,shot_id,principal,created_at,body) VALUES(?,?,?,?,?,?,?)",
            params![key,batch,project,choice.shot_id,principal,created,stringify(&run)])?;
    }
    c.next_revision()?;
    Ok(Value::Null)
}
fn advance(c: &mut Context, principal: &str, cmd: &Value) -> Result<Value> {
    let mut run = one(c, principal, id(cmd, "id")?)?;
    if let Some(project) = cmd.get("projectId")
        && *project != run["projectId"]
    {
        return Err(not_found());
    }
    if finished(&run) {
        return Ok(run);
    }
    if cmd["kind"] == "studio.videoCancel" {
        run["cancelRequested"] = true.into();
        save(c, &run, false)?;
        return Ok(run);
    }
    let state = text(cmd, "status", 16, false)?;
    if !matches!(
        state,
        "queued" | "running" | "succeeded" | "cancelled" | "interrupted" | "failed"
    ) {
        return Err(invalid("无效的镜头任务状态"));
    }
    let before = run.clone();
    run["status"] = state.into();
    if let Some(task) = cmd["taskId"].as_str() {
        run["taskId"] = task.into();
    }
    for k in ["error", "gpuRetry", "effective", "telemetry"] {
        if let Some(v) = cmd.get(k).filter(|value| !value.is_null()) {
            run[k] = v.clone();
        }
    }
    if state == "succeeded" {
        let task = id(&run, "taskId")?;
        let key = format!("studio-render-{}", id(&run, "id")?);
        let output:Value=c.db.query_row("SELECT o.media_json FROM task_outputs o JOIN tasks t USING(task_id) WHERE t.task_id=? AND t.principal_id=? AND t.request_key=? AND o.output_index=0 AND o.committed=1",params![task,principal,key],|r|json_column(r,0)).optional()?.ok_or_else(||conflict("TASK_RESULT_MISSING","视频尚未保存到工作区"))?;
        let clip = format!("studio-clip-{}", id(&run, "id")?);
        let refs = [
            &run["firstVersionId"],
            &run["lastVersionId"],
            &run["audioVersionId"],
        ]
        .into_iter()
        .filter(|v| !v.is_null())
        .collect::<Vec<_>>();
        let mut source = json!({"kind":"generation","taskId":task,"outputIndex":0,"inputVersionIds":refs,"modelId":run["input"]["modelId"],
            "seed":run["settings"]["seed"],"prompt":run["settings"]["prompt"]});
        for field in ["width", "height"] {
            if let Some(n) = run["effective"][field].as_u64() {
                source[field] = n.into();
            }
        }
        let title = run["shotTitle"].as_str().unwrap_or("分镜");
        let trimmed = title.chars().take(65).collect::<String>();
        import_asset(
            c,
            &json!({"assetId":clip,"versionId":clip,"title":format!("{trimmed} · 视频"),"kind":"clip","expectedRevision":0,
            "source":source,"mediaAlias":output["alias"],"sha256":output["sha256"]}),
        )?;
        run["clipVersionId"] = clip.into();
        let shot = required(c, "studio_shots", id(&run, "shotId")?)?;
        let expected = run["preparation"]
            .get("bindRevision")
            .unwrap_or(&run["shotRevision"]);
        if shot["revision"] == *expected && run["cancelRequested"] != true {
            set_current(c, shot, &run["clipVersionId"])?;
        }
    }
    if run != before {
        save(c, &run, finished(&run))?;
        if finished(&run) {
            c.next_revision()?;
        }
    }
    Ok(run)
}
fn set_current(c: &Context, mut shot: Value, clip: &Value) -> Result<()> {
    version_mime(c, clip, &["video/mp4", "video/webm"])?;
    shot["currentClipVersionId"] = clip.clone();
    shot["revision"] = (positive(&shot, "revision")? + 1).into();
    c.db.execute(
        "UPDATE studio_shots SET body=? WHERE id=?",
        params![stringify(&shot), id(&shot, "id")?],
    )?;
    Ok(())
}
pub(super) fn execute(c: &mut Context, principal: &str, cmd: &Value) -> Result<Value> {
    match cmd["kind"].as_str() {
        Some("studio.videoSelect") => c.transaction(|c| {
            let run = one(c, principal, id(cmd, "runId")?)?;
            let shot = required(c, "studio_shots", id(cmd, "shotId")?)?;
            if run["projectId"] != cmd["projectId"]
                || run["shotId"] != shot["id"]
                || run["status"] != "succeeded"
                || !run["clipVersionId"].is_string()
            {
                return Err(invalid("仅可选用本镜头已完成的历史片段"));
            }
            if shot["currentClipVersionId"] != run["clipVersionId"] {
                check_revision(&shot, cmd)?;
                set_current(c, shot, &run["clipVersionId"])?;
                c.next_revision()?;
            }
            Ok(Value::Null)
        }),
        Some("studio.videoEnqueue") => c.transaction(|c| enqueue(c, principal, cmd)),
        Some("studio.videoFrame") => c.transaction(|c| frames::advance(c, principal, cmd)),
        Some("studio.videoCancel" | "studio.videoAdvance") => {
            c.transaction(|c| advance(c, principal, cmd))
        }
        Some("studio.videoRun") => {
            let row = one(c, principal, id(cmd, "id")?)?;
            if row["projectId"] != cmd["projectId"] {
                return Err(not_found());
            }
            Ok(row)
        }
        Some("studio.videoList") => {
            let project = id(cmd, "projectId")?;
            required(c, "studio_projects", project)?;
            let history = rows(
                c,
                "SELECT body FROM studio_video_runs WHERE project_id=? AND principal=? ORDER BY created_at DESC,rowid DESC",
                params![project, principal],
            )?;
            Ok(history.into())
        }
        Some("studio.videoPending") => {
            let pending = rows(
                c,
                "SELECT body FROM studio_video_runs WHERE principal=? AND done=0 ORDER BY created_at,rowid",
                [principal],
            )?;
            Ok(pending.into())
        }
        Some("studio.videoOwners") => {
            let mut stmt =
                c.db.prepare("SELECT principal FROM studio_video_runs WHERE done=0 UNION SELECT principal FROM studio_exports WHERE done=0")?;
            let owners = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(owners.into())
        }
        _ => Err(invalid("未知的分镜视频操作")),
    }
}
