use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle,
};
use tauri_plugin_dialog::DialogExt;

/// 顶层原始字节避免把图片展开为 JSON 数字数组；文件名仅占用一个 UTF-8 编码头。
#[tauri::command]
pub async fn save_image(app: AppHandle, request: Request<'_>) -> Result<serde_json::Value, String> {
    let data = match request.body() {
        InvokeBody::Raw(data) => data.clone(),
        // Tauri 的 postMessage 回退将同一顶层 Uint8Array 转成 JSON 数组。
        InvokeBody::Json(data) => Vec::<u8>::deserialize(data).map_err(|e| e.to_string())?,
    };
    let default_name = request
        .headers()
        .get("x-aics-image-name")
        .map(|encoded| {
            let bytes = STANDARD
                .decode(encoded.as_bytes())
                .map_err(|e| e.to_string())?;
            String::from_utf8(bytes).map_err(|e| e.to_string())
        })
        .transpose()?
        .unwrap_or_else(|| "image.png".into());
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let file_path = app
            .dialog()
            .file()
            .set_file_name(&default_name)
            .blocking_save_file();
        match file_path {
            Some(path) => match path.into_path() {
                Ok(path) => match std::fs::write(&path, data) {
                    Ok(_) => {
                        serde_json::json!({ "saved": true, "filePath": path.to_string_lossy() })
                    }
                    Err(e) => serde_json::json!({ "saved": false, "error": e.to_string() }),
                },
                Err(e) => serde_json::json!({ "saved": false, "error": e.to_string() }),
            },
            None => serde_json::json!({ "saved": false }),
        }
    })
    .await;
    Ok(saved.unwrap_or_else(|e| serde_json::json!({ "saved": false, "error": e.to_string() })))
}
