use super::*;
use crate::storage::Storage;

pub(super) async fn handle(state: &AppState, input: &Value, principal: &str) -> Result<Value> {
    let action = input["action"].as_str().unwrap_or("");
    let id = input["operationId"].as_str().filter(|s| uuid::Uuid::parse_str(s).is_ok()).ok_or_else(|| ApiError::invalid("Invalid backup operation"))?;
    let root = state.config.config_root.as_ref().ok_or_else(|| ApiError::invalid("Desktop config unavailable"))?;
    if action == "portable-activate" {
        let id = input["workspaceId"].as_str().filter(|s| uuid::Uuid::parse_str(s).is_ok()).ok_or_else(|| ApiError::invalid("Invalid restore identity"))?;
        if state.host.active().is_some_and(|pointer| pointer["workspaceId"] == id) { return Ok(json!({"workspaceId":id,"activated":true})); }
        let _operation = state.host.operation.try_lock().map_err(|_| ApiError::new(409,"WORKSPACE_BUSY","工作区正在维护"))?;
        let _maintenance = state.host.maintenance()?;
        tokio::time::timeout(std::time::Duration::from_secs(30),state.host.wait_for_writes()).await.map_err(|_| ApiError::invalid("工作区保存尚未排空"))?;
        if let Some(old) = state.host.storage() {
            let open = old.request(json!({"kind":"task.list","scope":"open","limit":1}),principal).await?;
            let plans = old.request(json!({"kind":"imageBatch.list"}),principal).await?;
            if open["items"].as_array().is_some_and(|items| !items.is_empty()) || plans.as_array().is_some_and(|plans| plans.iter().any(|plan| plan["state"]=="running")) {
                return Err(ApiError::new(409,"WORKSPACE_BUSY","请先完成或暂停当前任务，再切换恢复副本"));
            }
        }
        let directory = crate::storage::portable_workspace_path(root,id)?;
        let marker: Value = serde_json::from_slice(&std::fs::read(directory.join("portable-restore.json"))?)?;
        if marker["workspaceId"] != id { return Err(ApiError::invalid("恢复副本身份不匹配")); }
        let restored = Storage::open(directory,id.into(),false).await?
            .with_native_images(crate::native_images::library_path(&state.config));
        let status = restored.request(json!({"kind":"status"}),principal).await?;
        let pointer = json!({"formatVersion":1,"workspaceId":id,"generation":state.host.active().and_then(|p|p["generation"].as_u64()).unwrap_or(0)+1,
            "domains":["artwork","settings","chat","draft"],"activatedRevision":status["revision"],"migrationId":id,
            "backupId":marker["backupId"],"restoreCandidateId":id,"bundledUi":true});
        activation::write_pointer(root,&pointer,false)?;
        let previous = state.host.storage();
        state.host.install(restored,pointer,false);
        if let Some(previous) = previous { if let Err(error) = previous.close().await { eprintln!("previous workspace close after portable activation: {error}"); } }
        return Ok(json!({"workspaceId":id,"activated":true}));
    }
    let path = input["path"].as_str().filter(|path| !path.is_empty()).ok_or_else(|| ApiError::invalid("Choose a backup file"))?;
    let storage = state.host.storage();
    if action == "artwork-export" && state.host.active().is_none_or(|active| active["workspaceId"] != input["workspaceId"]) {
        return Err(ApiError::invalid("作品库连接已变化，请回到原工作区重新导出"));
    }
    let command = json!({"kind":action,"operationId":id,"path":path,"backupId":input["backupId"],"workspaceId":input["workspaceId"]});
    let owned = state.clone(); let principal_owned = principal.to_owned();
    let snapshot = state.host.jobs.start(principal,command.clone(),state.shutdown.clone(),move |job| async move {
        let path = std::path::PathBuf::from(command["path"].as_str().unwrap());
        if !path.is_absolute() { return Err(ApiError::invalid("Backup path must be absolute")); }
        if command["kind"] == "artwork-export" {
            let storage = storage.ok_or_else(||ApiError::invalid("Workspace unavailable"))?;
            storage.export_artwork_images(path,principal_owned,command["operationId"].as_str().unwrap().into(),job).await
        } else if command["kind"] == "portable-export" {
            let storage = storage.ok_or_else(||ApiError::invalid("Workspace unavailable"))?;
            storage.export_portable_backup(command["backupId"].as_str().unwrap_or("").into(),path,job).await
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let root = owned.config.config_root.as_ref().unwrap();
            let destination = crate::storage::portable_workspace_path(root,&id)?;
            Storage::import_portable_backup(path,destination,id,principal_owned,job).await
        }
    })?;
    Ok(json!({"job":snapshot}))
}
