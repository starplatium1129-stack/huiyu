use super::ControlService;
use crate::error::{ApiError, Result};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{process::Stdio, sync::Arc, time::Duration};

// The caller key is DPAPI-protected in the user's existing deployment vault.
// Only the local control router can request it. Never serialize the agent key.
pub(super) async fn muse_token(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    let (url, token) = muse_credentials(&s, false).await?;
    Ok(Json(
        json!({"ok":true,"url":url.origin().ascii_serialization(),"token":token}),
    ))
}

async fn muse_credentials(s: &ControlService, require_worker: bool) -> Result<(reqwest::Url, String)> {
    let unavailable = || {
        ApiError::new(
            404,
            "MUSE_TOKEN_UNAVAILABLE",
            "无法读取这台电脑保存的 Muse 调用方密钥，请确认登录的是开通中转时的 Windows 用户",
        )
    };
    let url = crate::images::remote::muse_relay_address(&s.config.runtime_root)
        .await
        .ok_or_else(unavailable)?;
    let mut command = tokio::process::Command::new("powershell.exe");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
        $ErrorActionPreference='Stop'
        $pair=Import-Clixml -LiteralPath (Join-Path $env:LOCALAPPDATA 'com.aics.studio/muse-relay/connection.clixml')
        $conn=Get-Content -Raw -LiteralPath $env:HUIYU_MUSE_CONNECTOR | ConvertFrom-Json
        if (([Net.NetworkCredential]::new('', $pair.Agent)).Password -cne $conn.agentToken) { exit 1 }
        if ($env:HUIYU_MUSE_REQUIRE_WORKER -eq '1') {
            $relay = [Uri]$conn.url
            if ($relay.GetLeftPart([UriPartial]::Authority) -cne $env:HUIYU_MUSE_ORIGIN) { exit 1 }
            $pattern = '^' + [regex]::Escape([string]$pair.Name) + '\.[a-z0-9-]+\.workers\.dev$'
            if ($pair.Name -cnotmatch '^huiyu-muse-[a-f0-9]{10}$' -or !$relay.IsDefaultPort -or $relay.Host -cnotmatch $pattern) { exit 1 }
        }
        [Console]::Write(([Net.NetworkCredential]::new('', $pair.Muse)).Password)
    "#])
    .env("HUIYU_MUSE_CONNECTOR", s.config.runtime_root.join("muse-relay.json"))
    .env("HUIYU_MUSE_ORIGIN", url.origin().ascii_serialization())
    .env("HUIYU_MUSE_REQUIRE_WORKER", if require_worker { "1" } else { "0" })
    .stdin(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(6), command.output())
        .await
        .ok()
        .and_then(|v| v.ok())
        .filter(|v| v.status.success())
        .ok_or_else(unavailable)?;
    let token = std::str::from_utf8(&output.stdout)
        .ok()
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(unavailable)?;
    Ok((url, token.to_owned()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MuseRelayConnectionStatus {
    ok: bool,
    laptop_online: bool,
    last_seen_at: Option<u64>,
    storage: Option<MuseRelayStorage>,
    capabilities: Option<MuseRelayCapabilities>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MuseRelayStorage {
    used_bytes: u64,
    max_bytes: u64,
    ready_files: u64,
    transferring_files: u64,
    oldest_expires_at: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MuseRelayCapabilities {
    voice: bool,
    model_read: bool,
}

pub(super) async fn muse_relay_status(
    Extension(s): Extension<Arc<ControlService>>,
) -> Result<Json<Value>> {
    let operation = async {
        let (url, token) = muse_credentials(&s, true).await?;
        let invalid_response = || {
            ApiError::new(502, "MUSE_STATUS_PROTOCOL", "中转返回的状态格式无效")
        };
        let network_error = |error: reqwest::Error| {
            if error.is_timeout() {
                ApiError::new(504, "MUSE_STATUS_TIMEOUT", "检查中转状态超时")
            } else {
                ApiError::new(502, "MUSE_STATUS_UNAVAILABLE", "无法连接已配置的 Muse 中转")
            }
        };
        let endpoint = url.join("/api/muse/connection").map_err(|_| invalid_response())?;
        let mut token = reqwest::header::HeaderValue::from_str(&token).map_err(|_| invalid_response())?;
        token.set_sensitive(true);
        let mut response = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(network_error)?
            .get(endpoint)
            .header("X-Token", token)
            .header(reqwest::header::USER_AGENT, "Huiyu-Muse/1.0")
            .send()
            .await
            .map_err(network_error)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(ApiError::new(502, "MUSE_STATUS_REJECTED", "中转未返回状态，请检查中转配置"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len() + chunk.len() > 4096 {
                return Err(invalid_response());
            }
            bytes.extend_from_slice(&chunk);
        }
        let status: MuseRelayConnectionStatus = serde_json::from_slice(&bytes).map_err(|_| invalid_response())?;
        if !status.ok || status.storage.as_ref().is_some_and(|storage| storage.max_bytes == 0) {
            return Err(invalid_response());
        }
        Ok(Json(json!({
            "ok": true, "url": url.origin().ascii_serialization(),
            "laptopOnline": status.laptop_online, "lastSeenAt": status.last_seen_at,
            "storage": status.storage, "capabilities": status.capabilities
        })))
    };
    tokio::select! {
        biased;
        _ = s.shutdown.cancelled() => Err(ApiError::new(499, "ABORT_ERR", "检查中转状态已取消")),
        result = operation => result,
    }
}
