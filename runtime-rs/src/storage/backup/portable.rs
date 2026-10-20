use super::*;
use std::io::{Read, Write};
use sha2::{Digest, Sha256};
const MAGIC: &[u8] = b"HUIYU-BACKUP-1\n";

fn entries(manifest: &Value) -> Result<Vec<(String, Value)>> {
    let mut entries = vec![("huiyu.sqlite3".into(),manifest["database"].clone())];
    for item in manifest["media"].as_array().ok_or_else(|| invalid_backup("Invalid media manifest"))? {
        entries.push((object_relative(string(item,"hash")?)?,json!({"bytes":item["bytes"],"sha256":item["hash"]})));
    }
    Ok(entries)
}
fn transfer(input: &mut impl Read, output: &mut impl Write, expected: &Value, job: &crate::workspace_jobs::Job) -> Result<()> {
    let mut left = expected["bytes"].as_u64().ok_or_else(|| invalid_backup("Missing file size"))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    while left > 0 {
        job.check()?;
        let amount = left.min(buffer.len() as u64) as usize;
        input.read_exact(&mut buffer[..amount])?;
        output.write_all(&buffer[..amount])?;
        hash.update(&buffer[..amount]); left -= amount as u64;
    }
    if hex::encode(hash.finalize()) != expected["sha256"].as_str().unwrap_or("") { return Err(invalid_backup("Portable backup checksum mismatch")); }
    Ok(())
}
pub(in crate::storage) fn export(root: PathBuf, workspace_id: String, id: String, target: PathBuf, job: Arc<crate::workspace_jobs::Job>) -> Result<Value> {
    valid_id(&id)?;
    let files = Files { root,workspace_id,cancel:job.cancel.clone(),job:Some(job.clone()) };
    let directory = schema::safe(&files.root,format!("backups/{id}"))?;
    let manifest = manifest(&files,&directory,&id)?;
    verify_snapshot(&files,&directory,&manifest)?;
    let parent = target.parent().ok_or_else(|| invalid_backup("Invalid destination"))?;
    let target = schema::safe(parent,target.file_name().ok_or_else(|| invalid_backup("Invalid destination"))?)?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    let header = serde_json::to_vec(&manifest)?;
    output.write_all(MAGIC)?; output.write_all(&(header.len() as u64).to_le_bytes())?; output.write_all(&header)?;
    let entries = entries(&manifest)?;
    for (index,(relative,expected)) in entries.iter().enumerate() {
        job.progress("exporting-backup",index as u64,entries.len() as u64);
        let mut input = fs::File::open(schema::safe(&directory,relative)?)?;
        transfer(&mut input,&mut output,expected,&job)?;
    }
    job.check()?; output.as_file().sync_all()?;
    output.persist_noclobber(&target).map_err(|error| ApiError::new(409,"BACKUP_DESTINATION_EXISTS",format!("请选择新的备份文件名：{}",error.error)))?;
    Ok(json!({"path":target,"backupId":id,"mediaCount":manifest["media"].as_array().unwrap().len()}))
}

pub(in crate::storage) fn import(source: PathBuf, destination: PathBuf, id: String, principal: String, job: Arc<crate::workspace_jobs::Job>) -> Result<Value> {
    valid_id(&id)?;
    let source = schema::safe(source.parent().ok_or_else(|| invalid_backup("Invalid backup path"))?,source.file_name().unwrap())?;
    let mut input = fs::File::open(source)?;
    let mut magic = vec![0;MAGIC.len()]; input.read_exact(&mut magic)?;
    if magic != MAGIC { return Err(invalid_backup("请选择绘遇完整备份包（.huiyu）")); }
    let mut length = [0u8;8]; input.read_exact(&mut length)?;
    let length = u64::from_le_bytes(length);
    if !(1..=16*1024*1024).contains(&length) { return Err(invalid_backup("Invalid backup header size")); }
    let mut header = vec![0u8;length as usize]; input.read_exact(&mut header)?;
    let manifest: Value = serde_json::from_slice(&header)?;
    let original_id = string(&manifest,"workspaceId")?.to_owned();
    let backup_id = string(&manifest,"backupId")?.to_owned(); valid_id(&backup_id)?; valid_id(&original_id)?;
    let parent = destination.parent().ok_or_else(|| invalid_backup("Invalid workspace destination"))?;
    fs::create_dir_all(parent)?;
    let destination = schema::safe(parent,&id)?;
    if destination.exists() { return Err(invalid_backup("恢复副本编号已存在，请重新导入")); }
    let temporary = tempfile::Builder::new().prefix("portable-import-").tempdir_in(parent)?;
    let root = temporary.path().to_path_buf();
    let files = Files {root:root.clone(),workspace_id:original_id,cancel:job.cancel.clone(),job:Some(job.clone())};
    let manifest = validate_manifest(&files,manifest,&backup_id)?;
    let entries = entries(&manifest)?;
    for (index,(relative,expected)) in entries.iter().enumerate() {
        job.progress("importing-backup",index as u64,entries.len() as u64);
        let target = schema::safe(&root,relative)?;
        fs::create_dir_all(target.parent().unwrap())?;
        let mut output = OpenOptions::new().create_new(true).write(true).open(target)?;
        transfer(&mut input,&mut output,expected,&job)?; output.sync_all()?;
    }
    if input.read(&mut [0u8;1])? != 0 { return Err(invalid_backup("Backup contains trailing data")); }
    schema::write_new(&root.join("workspace.json"),&json!({"workspaceId":files.workspace_id,"databaseKind":"huiyu-workspace","schemaVersion":manifest["schemaVersion"]}))?;
    verify_snapshot(&files,&root,&manifest)?;
    job.progress("preparing-workspace",0,1);
    {
        let db = Connection::open(schema::safe(&root,"huiyu.sqlite3")?)?;
        db.execute_batch("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE;")?;
        db.execute("UPDATE meta SET value=? WHERE key='workspaceId'",[&id])?;
        db.execute("UPDATE meta SET value='' WHERE key='writerEpoch'",[])?;
        // Imported tasks are historical receipts, never permission to contact the
        // source machine's providers or automatically restart its queued work.
        if manifest["schemaVersion"].as_u64().unwrap() >= 3 {
            db.execute("UPDATE tasks SET principal_id=?,upstream_settled=1,record_json=json_set(record_json,'$.principalId',?,'$.workspaceId',?,'$.runtimeEpoch','','$.upstreamId',NULL,'$.upstreamSettled',json('true'),'$.status',CASE WHEN upstream_settled=0 THEN 'failed' ELSE json_extract(record_json,'$.status') END,'$.errorCode',CASE WHEN upstream_settled=0 THEN 'IMPORTED_HISTORY_ONLY' ELSE json_extract(record_json,'$.errorCode') END)",params![principal,principal,id])?;
            db.execute("DELETE FROM task_cancel_intents",[])?;
        }
        if manifest["schemaVersion"].as_u64().unwrap() >= 5 {
            rebind_batches(&db,&id,&principal)?;
        }
        db.execute_batch("DELETE FROM leases; DELETE FROM operations; COMMIT;")?;
    }
    let identity = json!({"workspaceId":id,"databaseKind":"huiyu-workspace","schemaVersion":manifest["schemaVersion"]});
    { let mut file = fs::File::create(root.join("workspace.json"))?; file.write_all(&serde_json::to_vec(&identity)?)?; file.sync_all()?; }
    let result = json!({"workspaceId":id,"backupId":backup_id,"sourceWorkspaceId":files.workspace_id,"revision":manifest["revision"],"mediaCount":manifest["media"].as_array().unwrap().len()});
    schema::write_new(&root.join("portable-restore.json"),&result)?;
    job.check()?;
    fs::rename(&root,&destination)?;
    schema::sync_dir(parent)?;
    Ok(result)
}

fn rebind_batches(db: &Connection, workspace: &str, principal: &str) -> Result<()> {
    fn rebind(plan: &mut Value, workspace: &str, principal: &str) -> Result<()> {
        if !plan.is_object() || !plan["jobs"].is_array() { return Err(invalid_backup("Invalid saved image batch")); }
        plan["owner"] = json!({"kind":"workspace","workspaceId":workspace,"principalId":principal});
        for job in plan["jobs"].as_array_mut().unwrap() {
            if matches!(job["status"].as_str(),Some("running"|"accepted"|"unknown")) {
                job["status"] = json!("failed");
                job["error"] = json!("备份中的未完成请求仅保留历史；如需生成，请显式重试。");
            }
        }
        Ok(())
    }
    let rows = db.prepare("SELECT id,body FROM image_batch_plans")?.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (id,body) in rows {
        let mut plan: Value = serde_json::from_str(&body)?;
        rebind(&mut plan,workspace,principal)?;
        plan["state"] = json!("paused"); plan["error"] = json!("从备份恢复的批次保持暂停，请核对后继续或重新编排");
        if plan["source"].is_object() { plan["source"]["owner"] = plan["owner"].clone(); }
        db.execute("UPDATE image_batch_plans SET principal=?,body=? WHERE id=?",params![principal,stringify(&plan),id])?;
    }
    let rows = db.prepare("SELECT record_key,body FROM profile_records WHERE domain='draft' AND (record_key='aics_pb_batch_plan_v1' OR record_key LIKE '%:aics_pb_batch_plan_v1')")?
        .query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (key,body) in rows {
        let value: Value = serde_json::from_str(&body)?;
        if value.is_null() { continue; }
        let encoded = value.is_string();
        let mut plan = if let Some(text) = value.as_str() { serde_json::from_str(text)? } else { value };
        rebind(&mut plan,workspace,principal)?;
        let value = if encoded { json!(stringify(&plan)) } else { plan };
        db.execute("UPDATE profile_records SET body=? WHERE domain='draft' AND record_key=?",params![stringify(&value),key])?;
    }
    Ok(())
}
