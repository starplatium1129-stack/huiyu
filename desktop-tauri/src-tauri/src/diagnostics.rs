use crate::{bootstrap, mutex::RecoverMutex, paths::DesktopPaths, state::AppState};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const LOG_BYTES: u64 = 128 * 1024;
const LOG_LINES: usize = 200;
static EXPORTING: AtomicBool = AtomicBool::new(false);

struct ExportGuard;
impl Drop for ExportGuard {
    fn drop(&mut self) { EXPORTING.store(false, Ordering::Release); }
}

#[tauri::command]
pub(crate) async fn desktop_export_diagnostics(window: WebviewWindow) -> Result<bool, String> {
    bootstrap::require_atelier(&window)?;
    request_export(window.app_handle().clone()).await
}

pub(crate) async fn request_export(app: AppHandle) -> Result<bool, String> {
    if EXPORTING.swap(true, Ordering::AcqRel) { return Err("已有诊断导出正在进行".into()); }
    let _guard = ExportGuard;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog().file()
        .set_title("保存脱敏诊断包")
        .set_file_name("huiyu-diagnostics.zip")
        .add_filter("ZIP", &["zip"])
        .save_file(move |path| { let _ = send.send(path); });
    let Some(path) = receive.await.map_err(|_| "无法打开诊断包保存窗口")? else { return Ok(false); };
    let path = path.into_path().map_err(|_| "无法使用选择的诊断包保存位置")?;
    let state = app.state::<AppState>();
    let paths = state.paths.clone();
    let preferences = state.preferences.recover_lock().clone();
    let version = app.package_info().version.to_string();
    let logger = state.log.clone();
    tauri::async_runtime::spawn_blocking(move || {
        logger.flush();
        let device = json!({
            "desktopVersion": version,
            "os": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "osBuild": windows_build(),
            "webView2": tauri::webview_version().ok().filter(|value| is_version(value)),
            "displayAdapters": display_adapters(),
            "gatewayProtocol": crate::gateway::DESKTOP_GATEWAY_PROTOCOL,
            "configuration": {
                "packaged": paths.is_packaged,
                "startupMode": preferences.startup_mode,
                "isolatedLive2dRenderer": crate::live2d_process::enabled(),
                "nativeLive2dPreference": preferences.live2d_enabled,
                "clipboardAwareness": preferences.clipboard_awareness,
            }
        });
        write_archive(&path, &paths, &device).map_err(|_| "无法写入诊断包，请检查保存位置与剩余空间".to_owned())
    }).await.map_err(|_| "诊断包导出已中断".to_owned())??;
    Ok(true)
}

fn is_version(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.')
}

fn windows_build() -> Option<[u32; 3]> {
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    #[link(name = "ntdll")]
    extern "system" { fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32; }
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of_val(&info) as u32;
    (unsafe { RtlGetVersion(&mut info) } == 0).then_some([
        info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
    ])
}

fn display_adapters() -> Vec<Value> {
    use windows_sys::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
    let mut adapters = Vec::new();
    for index in 0..16 {
        let mut device: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
        device.cb = std::mem::size_of_val(&device) as u32;
        if unsafe { EnumDisplayDevicesW(std::ptr::null(), index, &mut device, 0) } == 0 { break; }
        let hardware = String::from_utf16_lossy(&device.DeviceID);
        let code = |prefix: &str| {
            let digits = hardware.split_once(prefix)?.1.get(..4)?;
            digits.bytes().all(|byte| byte.is_ascii_hexdigit()).then_some(digits)
        };
        if let (Some(vendor), Some(model)) = (code("VEN_"), code("DEV_")) {
            let id = json!({ "pciVendor": vendor, "pciDevice": model });
            if !adapters.contains(&id) { adapters.push(id); }
        }
    }
    adapters
}

fn write_archive(output: &Path, paths: &DesktopPaths, device: &Value) -> Result<(), Box<dyn std::error::Error>> {
    let parent = output.parent().ok_or("destination has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    {
        let mut zip = zip::ZipWriter::new(temporary.as_file_mut());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("environment.json", options)?;
        serde_json::to_writer_pretty(&mut zip, device)?;
        zip.start_file("desktop-events.log", options)?;
        for path in [paths.desktop_log.with_extension("log.1"), paths.desktop_log.clone()] {
            write_log(&mut zip, &path)?;
        }
        zip.start_file("gateway-events.log", options)?;
        write_log(&mut zip, &paths.runtime_root.join("logs/gateway.log"))?;
        zip.finish()?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(output)?;
    Ok(())
}

fn write_log(output: &mut impl Write, path: &Path) -> std::io::Result<()> {
    let Ok(mut file) = File::open(path) else { return Ok(()); };
    let bytes = file.metadata()?.len().min(LOG_BYTES);
    file.seek(SeekFrom::End(-(bytes as i64)))?;
    let mut buffer = Vec::with_capacity(bytes as usize);
    file.take(LOG_BYTES).read_to_end(&mut buffer)?;
    let contents = String::from_utf8_lossy(&buffer);
    let lines = contents.lines().rev().take(LOG_LINES).collect::<Vec<_>>();
    for line in lines.into_iter().rev() {
        // Never export arbitrary prose: it can contain credentials, filesystem
        // paths, image prompts or URL headers. Only fixed categories survive.
        let lower = line.to_ascii_lowercase();
        let level = ["error", "warn", "info", "debug"]
            .into_iter().find(|level| lower.contains(&format!("[{level}]"))).unwrap_or("event");
        let event = if lower.contains("gateway restart failed") { "gateway-restart-failed" }
            else if lower.contains("gateway recovered") { "gateway-recovered" }
            else if lower.contains("gateway start failed") { "gateway-start-failed" }
            else if lower.contains("panic") { "panic" }
            else if lower.contains("workspace") { "workspace" }
            else if lower.contains("renderer") || lower.contains("live2d") { "live2d" }
            else if lower.contains("updat") { "update" }
            else if lower.contains("task") { "task" }
            else { "other" };
        let timestamp = line.split_ascii_whitespace().next().unwrap_or("");
        let timestamp = if timestamp.len() == 10 && timestamp.bytes().all(|byte| byte.is_ascii_digit()) {
            timestamp
        } else { "-" };
        writeln!(output, "{timestamp} [{level}] {event}")?;
    }
    Ok(())
}
