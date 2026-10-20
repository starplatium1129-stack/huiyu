use serde_json::{Value,json};
use tauri::{Manager,WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// File paths originate only from the native picker, never renderer arguments.
#[tauri::command]
pub async fn workspace_portable_backup(window: WebviewWindow, action: String, operation_id: String, backup_id: Option<String>, workspace_id: Option<String>) -> Result<Value,String> {
    if window.label() != "atelier" { return Err("备份操作只能在主工作台执行".into()); }
    let app = window.app_handle().clone();
    let url = window.url().map_err(|error|error.to_string())?;
    if !crate::main_shared::is_gateway_origin(&app,&url) { return Err("备份来源未授权".into()); }
    if !matches!(action.as_str(),"export"|"import"|"status"|"cancel"|"activate") { return Err("不支持的备份操作".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let path = match action.as_str() {
            "export" => app.dialog().file().set_title("保存完整工作区备份").add_filter("绘遇备份",&["huiyu"]).set_file_name("绘遇工作区.huiyu").blocking_save_file(),
            "import" => app.dialog().file().set_title("选择完整工作区备份").add_filter("绘遇备份",&["huiyu"]).blocking_pick_file(),
            _ => None,
        };
        if matches!(action.as_str(),"export"|"import") && path.is_none() { return Ok(json!({"cancelled":true})); }
        let path = path.map(|path|path.into_path().map_err(|error|error.to_string())).transpose()?;
        let source = app.state::<crate::state::AppState>().paths.source_profile_id.clone();
        let response = app.state::<crate::gateway::GatewaySupervisor>().host_request(json!({
            "action":match action.as_str() {"export"=>"portable-export","import"=>"portable-import","activate"=>"portable-activate","status"=>"operation-status",_=>"operation-cancel"},
            "windowId":"atelier","origin":url.origin().ascii_serialization(),"sourceProfileId":source,
            "operationId":operation_id,"backupId":backup_id,"workspaceId":workspace_id,"path":path,
        }))?.ok_or_else(||"本机运行时不可用".to_string())?;
        Ok(response.payload)
    }).await.map_err(|error|error.to_string())?
}
