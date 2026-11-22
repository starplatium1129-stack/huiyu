use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    shot_id: String,
    expected_revision: i64,
    clip_version_id: String,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    upscale: bool,
    interpolate: bool,
    use_shot_audio: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    shots: Vec<Selection>,
    options: Options,
}

fn freeze(c: &Context, version: &Value, accept: &[&str]) -> Result<Value> {
    let version = required(
        c,
        "studio_versions",
        version
            .as_str()
            .ok_or_else(|| invalid("镜头缺少已选片段"))?,
    )?;
    if !version["mime"]
        .as_str()
        .is_some_and(|m| accept.contains(&m))
    {
        return Err(invalid("所选镜头原件的格式与用途不同"));
    }
    Ok(
        json!({"mediaAlias":version["mediaAlias"],"sha256":version["sha256"],"bytes":version["bytes"],"mime":version["mime"]}),
    )
}
fn enqueue(c: &mut Context, owner: &str, cmd: &Value) -> Result<Value> {
    let key = id(cmd, "id")?;
    let project = id(cmd, "projectId")?;
    let hash = canonical::fingerprint(&cmd["request"]);
    if let Some(row) =
        c.db.query_row(
            "SELECT project_id,principal,fingerprint FROM studio_exports WHERE id=?",
            [key],
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
        if row != (project.to_owned(), owner.to_owned(), hash) {
            return Err(conflict(
                "STUDIO_EXPORT_CONFLICT",
                "此导出编号已绑定另一份时间线",
            ));
        }
        return Ok(Value::Null);
    }
    let spec: Request = serde_json::from_value(cmd["request"].clone())
        .map_err(|_| invalid("导出选项或镜头列表无效"))?;
    if !(1..=64).contains(&spec.shots.len()) {
        return Err(invalid("一次可导出 1 至 64 个镜头"));
    }
    let project_row = required(c, "studio_projects", project)?;
    let mut position = -1;
    let mut inputs = Vec::new();
    let mut shots = Vec::new();
    for item in spec.shots {
        let shot = required(c, "studio_shots", &item.shot_id)?;
        let next = shot["position"]
            .as_i64()
            .ok_or_else(|| invalid("镜头位置无效"))?;
        if shot["projectId"] != project || next <= position {
            return Err(invalid("请按时间线顺序选择本项目中的镜头"));
        }
        position = next;
        if shot["revision"] != item.expected_revision
            || shot["currentClipVersionId"] != item.clip_version_id
        {
            return Err(conflict(
                "REVISION_CONFLICT",
                "镜头或当前片段已变化，请刷新后重新导出",
            ));
        }
        let video = freeze(
            c,
            &shot["currentClipVersionId"],
            &["video/mp4", "video/webm"],
        )?;
        let audio_id = if spec.options.use_shot_audio {
            &shot["audioVersionId"]
        } else {
            &Value::Null
        };
        let audio = if audio_id.is_null() {
            Value::Null
        } else {
            freeze(c, audio_id, &["audio/wav"])?
        };
        inputs.push(json!({"video":video,"audio":audio}));
        shots.push(json!({"shotId":item.shot_id,"shotTitle":shot["title"],"clipVersionId":item.clip_version_id,"audioVersionId":audio_id}));
    }
    let created = now();
    let job = json!({"id":key,"projectId":project,"title":project_row["title"],"createdAt":created,
        "shots":shots,"options":spec.options,"status":"queued","progress":null,"message":"等待导出",
        "error":null,"cancelRequested":false,"clipVersionId":null,"_inputs":inputs,
        "_publication":uuid::Uuid::new_v4().to_string()});
    c.db.execute("INSERT INTO studio_exports(id,project_id,principal,fingerprint,created_at,body) VALUES(?,?,?,?,?,?)",
        params![key,project,owner,hash,created,stringify(&job)])?;
    c.next_revision()?;
    Ok(Value::Null)
}

fn record(c: &Context, owner: &str, cmd: &Value) -> Result<(Value, bool)> {
    c.db.query_row(
        "SELECT body,done FROM studio_exports WHERE id=? AND principal=?",
        params![id(cmd, "id")?, owner],
        |r| Ok((json_column(r, 0)?, r.get(1)?)),
    )
    .optional()?
    .filter(|(r, _)| {
        cmd.get("projectId")
            .is_none_or(|project| *project == r["projectId"])
    })
    .ok_or_else(|| ApiError::new(404, "STUDIO_EXPORT_NOT_FOUND", "找不到此导出任务"))
}

fn finish(c: &Context, owner: &str, job: &mut Value, cmd: &Value) -> Result<()> {
    let key = id(job, "id")?;
    let alias = format!("studio-export-{}", id(job, "_publication")?);
    let op = c.operation(owner, &alias)?;
    let committed = op.as_ref().is_some_and(|op| {
        op.kind == "prepareMedia"
            && op.state == "committed"
            && op.input["media"]["alias"] == alias
            && op.input["media"]["mime"] == "video/mp4"
    });
    if job["cancelRequested"] == true {
        job["status"] = "cancelled".into();
        job["message"] = "已取消导出".into();
    } else if committed {
        let clip = format!("studio-movie-{key}");
        let refs: Vec<_> = job["shots"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|s| [&s["clipVersionId"], &s["audioVersionId"]])
            .filter(|s| s.is_string())
            .collect();
        let title: String = job["title"]
            .as_str()
            .unwrap_or("分镜")
            .chars()
            .take(70)
            .collect();
        import_asset(
            c,
            &json!({"assetId":clip,"versionId":clip,"title":format!("{title} · 成片"),"kind":"clip",
            "expectedRevision":0,"mediaAlias":alias,"sha256":op.as_ref().unwrap().input["media"]["sha256"],"consumeUpload":true,
            "source":{"kind":"generation","taskId":format!("studio-export-{key}"),"outputIndex":0,"inputVersionIds":refs}}),
        )?;
        job["clipVersionId"] = clip.into();
        job["status"] = "succeeded".into();
        job["progress"] = 1.into();
        job["message"] = "成片已保存".into();
    } else {
        let state = text(cmd, "status", 16, false)?;
        if !matches!(state, "failed" | "interrupted") {
            return Err(conflict("MEDIA_MISSING", "导出原件尚未存入工作区"));
        }
        job["status"] = state.into();
        job["error"] = text(cmd, "message", 2000, false)?.into();
        job["message"] = job["error"].clone();
    }
    if let Some(op) =
        op.filter(|op| op.kind == "prepareMedia" && op.input["media"]["alias"] == alias)
    {
        if op.state == "prepared" {
            c.db.execute(
                "UPDATE operations SET state='aborted' WHERE op_key=?",
                [&op.key],
            )?;
            c.db.execute("DELETE FROM leases WHERE operation_key=?", [&op.key])?;
            media::cleanup(c, &op.key, &op.input["media"]);
        } else if job["status"] == "cancelled" {
            c.db.execute(
                "DELETE FROM media_refs WHERE owner_kind='temporary' AND owner_id=?",
                [&alias],
            )?;
        }
    }
    Ok(())
}
fn advance(c: &mut Context, owner: &str, cmd: &Value) -> Result<Value> {
    let (mut job, mut done) = record(c, owner, cmd)?;
    if done {
        return Ok(job);
    }
    match cmd["kind"].as_str() {
        Some("studio.exportCancel") => {
            job["cancelRequested"] = true.into();
            job["message"] = "正在取消导出".into();
            if job["status"] == "queued" {
                finish(c, owner, &mut job, cmd)?;
                done = true;
            }
        }
        Some("studio.exportStart") if job["status"] == "queued" => {
            job["status"] = "running".into();
            job["message"] = "正在读取镜头原件".into();
        }
        Some("studio.exportProgress") if job["status"] == "running" => {
            if job["cancelRequested"] != true {
                job["progress"] = cmd["progress"].clone();
                job["message"] = text(cmd, "message", 256, false)?.into();
                if let Some(facts) = cmd.get("metadata") {
                    job["metadata"] = facts.clone();
                }
            }
        }
        Some("studio.exportFinish") => {
            finish(c, owner, &mut job, cmd)?;
            done = true;
        }
        _ => return Err(conflict("STUDIO_EXPORT_STATE", "导出任务状态已变化")),
    }
    c.db.execute(
        "UPDATE studio_exports SET body=?,done=? WHERE id=?",
        params![stringify(&job), done, id(&job, "id")?],
    )?;
    if done {
        c.next_revision()?;
    }
    Ok(job)
}
pub(super) fn execute(c: &mut Context, owner: &str, cmd: &Value) -> Result<Value> {
    match cmd["kind"].as_str() {
        Some("studio.exportEnqueue") => c.transaction(|c|enqueue(c,owner,cmd)),
        Some("studio.exportList") => {
            let project = id(cmd,"projectId")?;
            required(c,"studio_projects",project)?;
            Ok(rows(c,"SELECT json_remove(body,'$._inputs','$._publication') FROM studio_exports WHERE project_id=? AND principal=? ORDER BY created_at DESC,rowid DESC",params![project,owner])?.into())
        }
        Some("studio.exportPending") => Ok(rows(c,"SELECT body FROM studio_exports WHERE principal=? AND done=0 ORDER BY created_at,rowid",[owner])?.into()),
        _ => c.transaction(|c|advance(c,owner,cmd)),
    }
}

impl Storage {
    /// The private snapshot is already hashed and fsynced. Publish through the same
    /// verified media commit as desktop uploads, without putting video bytes in JSON.
    pub(crate) async fn publish_studio_movie(
        &self,
        path: PathBuf,
        nonce: &str,
        owner: &str,
        facts: &Value,
    ) -> Result<()> {
        let bytes = tokio::fs::metadata(&path).await?.len();
        let (staged, hash) = self
            .verification
            .stage(self.root.clone(), path, bytes, self.sender.clone())
            .await?;
        if facts["sha256"] != hash || facts["bytes"] != bytes {
            return Err(conflict(
                "MEDIA_INVALID",
                "工作区接收的成片与导出器核验的原件不同",
            ));
        }
        let alias = format!("studio-export-{nonce}");
        let state = self
            .request(
                json!({"kind":"prepareMedia","operationId":alias,"media":{
            "alias":alias,"bytes":bytes,"mime":"video/mp4","sha256":hash}}),
                owner,
            )
            .await?;
        if state["state"] != "committed" {
            let key =
                canonical::digest(canonical::stringify(&json!([owner, "prepareMedia", alias])));
            let root = self.root.clone();
            let dest = media::staging_path(&root, &key, &alias)?;
            tokio::task::spawn_blocking(move || staged.install(&root, &dest))
                .await
                .map_err(|_| unavailable())??;
            self.request(json!({"kind":"commitMedia","operationId":alias}), owner)
                .await?;
        }
        Ok(())
    }
}
