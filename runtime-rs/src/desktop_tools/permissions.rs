use super::*;
use axum::http::Method;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Permissions {
    enabled: bool,
    read_files: bool,
    write_files: bool,
    capture_screen: bool,
    commands: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Patch {
    enabled: Option<bool>,
    read_files: Option<bool>,
    write_files: Option<bool>,
    capture_screen: Option<bool>,
    commands: Option<bool>,
}
pub(super) struct Store {
    path: PathBuf,
    writer: tokio::sync::Mutex<()>,
}
impl Store {
    pub(super) fn new(config: &Config) -> Self {
        Self {
            path: config
                .runtime_root
                .join("state/desktop-tool-permissions.json"),
            writer: tokio::sync::Mutex::new(()),
        }
    }
    async fn read(&self) -> Result<Permissions> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                Error::coded(
                    "TOOL_PERMISSIONS_UNAVAILABLE",
                    "本机工具权限记录无法读取，工具保持关闭",
                )
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(Permissions::default())
            }
            Err(error) => Err(error.into()),
        }
    }
    pub(super) async fn check(&self, name: &str, screen_authorized: bool) -> Result<()> {
        let permissions = self.read().await?;
        let allowed = permissions.enabled
            && match name {
                "read_file" | "read_image" | "list_files" => permissions.read_files,
                "write_file" => permissions.write_files,
                "capture_screen" => permissions.capture_screen && screen_authorized,
                "run_command" => permissions.commands,
                "get_workspace_info" => true,
                _ => false,
            };
        if !allowed {
            return Err(Error::coded(
                "TOOL_PERMISSION_DENIED",
                "此项本机工具未授权；截图还需逐次确认截取并发送给当前 API",
            ));
        }
        Ok(())
    }
}
pub(super) async fn handle(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<DesktopToolsService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    method: Method,
    body: Bytes,
) -> Response {
    if !security::is_direct_local(&headers, peer.ip()) {
        return (
            StatusCode::FORBIDDEN,
            Json(Error::coded("LOCAL_ONLY", "权限仅允许在本机设置").value()),
        )
            .into_response();
    }
    if let Err(error) = state.host.check_available() {
        return error.into_response();
    }
    let result = async {
        let _writer = service.permissions.writer.lock().await;
        let mut permissions = service.permissions.read().await?;
        if method == Method::PATCH {
            let patch: Patch =
                serde_json::from_slice(&body).map_err(|_| Error::plain("权限设置无效"))?;
            if let Some(value) = patch.enabled {
                permissions.enabled = value;
            }
            if let Some(value) = patch.read_files {
                permissions.read_files = value;
            }
            if let Some(value) = patch.write_files {
                permissions.write_files = value;
            }
            if let Some(value) = patch.capture_screen {
                permissions.capture_screen = value;
            }
            if let Some(value) = patch.commands {
                permissions.commands = value;
            }
            tokio::fs::create_dir_all(service.permissions.path.parent().unwrap()).await?;
            crate::generation::write_job_record(&service.permissions.path, &permissions)
                .await
                .map_err(Error::from)?;
        }
        Ok::<_, Error>(json!({"ok":true,"permissions":permissions}))
    }
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(error.value())).into_response(),
    }
}
