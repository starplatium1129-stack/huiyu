//! Bundled resource UI remains available while the authenticated gateway drains.
//! The renderer never supplies install roots, commands or approval fingerprints.
use std::{io::{BufRead, BufReader, Read}, path::PathBuf, process::{Command, Stdio, ChildStdin}, sync::Mutex};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, WebviewWindow};
use crate::state::AppState;

#[derive(Default)]
struct Job {
    archive: Option<PathBuf>, staging: Option<String>, input: Option<ChildStdin>,
    busy: bool, paused: bool, drained: bool, cancelled: bool, snapshot: Value,
}
#[derive(Default)]
pub struct ResourceAssistant(Mutex<Job>);

pub fn command(name: &str) -> bool {
    matches!(name, "resource_assistant_status" | "resource_assistant_pick" | "resource_assistant_install" | "resource_assistant_cancel" | "resource_assistant_finish")
}
pub fn recovery_pending(app: &AppHandle) -> bool {
    app.state::<AppState>().paths.runtime_root.join("offline-install-pending.json").exists()
}
pub fn trusted(window: &tauri::Webview<tauri::Wry>) -> bool {
    window.label() == "resource-assistant" && window.url().is_ok_and(|url|
        crate::ui_entry::native_origin(&url) && url.path() == "/resource-assistant.html")
}
pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("resource-assistant") {
        let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); return Ok(());
    }
    let mut builder = tauri::WebviewWindowBuilder::new(app, "resource-assistant",
        tauri::WebviewUrl::App("resource-assistant.html".into()))
        .title("绘遇 · 资源安装助手").inner_size(1000.0, 760.0).min_inner_size(680.0, 560.0)
        .center().on_navigation(|url| crate::ui_entry::native_origin(url) && url.path() == "/resource-assistant.html");
    if let Some(profile) = crate::ui_entry::isolated_profile() { builder = builder.data_directory(profile); }
    let window = builder.build().map_err(|error| error.to_string())?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let host = handle.state::<ResourceAssistant>();
            let mut job = host.0.lock().unwrap();
            if job.busy || job.paused {
                api.prevent_close();
                if job.busy { cancel(&mut job); }
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub fn open_resource_assistant(app: AppHandle) -> Result<(), String> { open(&app) }

fn snapshot(job: &Job) -> Value {
    let mut value = json!({"stage":"idle","phase":"","done":0,"total":0,"preview":null,"result":null,"error":null});
    if let Some(fields) = job.snapshot.as_object() { value.as_object_mut().unwrap().extend(fields.clone()); }
    value["busy"] = job.busy.into(); value["paused"] = job.paused.into();
    value["drainFailed"] = (job.paused && !job.drained).into();
    value["cancelRequested"] = job.cancelled.into(); value["canResume"] = job.staging.is_some().into();
    value
}
#[tauri::command]
pub fn resource_assistant_status(app: AppHandle) -> Value {
    snapshot(&app.state::<ResourceAssistant>().0.lock().unwrap())
}
fn cancel(job: &mut Job) {
    job.cancelled = true;
    // EOF is cooperative cancellation, also when the desktop host exits.
    job.input.take();
}
#[tauri::command]
pub fn resource_assistant_cancel(app: AppHandle) {
    let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
    if job.busy { cancel(&mut job); }
}
fn fail(app: &AppHandle, error: String) {
    app.state::<AppState>().warn(&format!("resource assistant: {error}"));
    let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
    job.busy = false; job.input.take();
    job.snapshot["stage"] = if job.cancelled { "cancelled" } else { "failed" }.into();
    job.snapshot["error"] = error.into();
}
#[tauri::command]
pub async fn resource_assistant_pick(window: WebviewWindow, directory: Option<bool>) -> Result<(), String> {
    let app = window.app_handle().clone();
    {
        let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
        if job.busy || job.paused { return Err("请先完成当前安装，或返回画室后重新选择。".into()); }
        job.busy = true; job.cancelled = false;
        job.snapshot["phase"] = "choosing".into();
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let dialog = window.dialog().file().set_parent(&window);
        let picked = if directory.unwrap_or(false) {
            dialog.set_title("选择已解压的绘遇素材文件夹").blocking_pick_folder()
        } else {
            dialog.set_title("选择绘遇资源包").add_filter("绘遇资源 ZIP", &["zip"]).blocking_pick_file()
        };
        picked
            .map(|file| file.into_path().map_err(|error| error.to_string())).transpose()
    }).await;
    let archive = match picked {
        Ok(Ok(Some(path))) => path,
        Ok(Ok(None)) => { let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap(); job.busy = false; job.snapshot["phase"] = "".into(); return Ok(()); }
        other => { fail(&app, format!("无法选择文件：{other:?}")); return Ok(()); }
    };
    {
        let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
        job.snapshot = json!({"stage":"checking","phase":"inventory","done":0,"total":0,"preview":null,"result":null,"error":null,
            "fileName":archive.file_name().unwrap_or_default().to_string_lossy(),"startedAt":milliseconds()});
        job.archive = Some(archive); job.staging = None;
    }
    tauri::async_runtime::spawn_blocking(move || { if let Err(error) = run(&app, false) { fail(&app, error); } });
    Ok(())
}
#[tauri::command]
pub async fn resource_assistant_install(app: AppHandle) -> Result<(), String> {
    let paused = {
        let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
        if job.busy || job.archive.is_none() || !job.snapshot["preview"].is_object() || job.snapshot["stage"] == "completed" {
            return Err("请先选择并识别资源包。".into());
        }
        if job.paused && !job.drained { return Err("画室暂停未确认，请先返回画室后重试。".into()); }
        job.busy = true; job.cancelled = false;
        job.snapshot["stage"] = "preparing".into(); job.snapshot["phase"] = "preparing".into();
        job.snapshot["error"] = Value::Null;
        job.snapshot["startedAt"] = milliseconds().into();
        job.paused
    };
    // Reserve synchronously before dispatch; repeated clicks cannot start a
    // second drain or overwrite the selected package.
    tauri::async_runtime::spawn(async move {
        if !paused {
            if let Err(error) = crate::maintenance::prepare_resources(&app).await {
                // Cancellation before drain thaws existing windows. A failed
                // drain remains frozen and can only leave through normal restart.
                app.state::<ResourceAssistant>().0.lock().unwrap().paused = crate::maintenance::active(&app);
                fail(&app, error); return;
            }
            let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
            job.paused = true; job.drained = true;
        }
        if app.state::<ResourceAssistant>().0.lock().unwrap().cancelled {
            fail(&app, "CANCELLED".into()); return;
        }
        let worker = app.clone();
        match tauri::async_runtime::spawn_blocking(move || run(&worker, true)).await {
            Ok(Ok(())) => {},
            Ok(Err(error)) => fail(&app, error),
            Err(error) => fail(&app, format!("安装进程未完成：{error}")),
        }
    });
    Ok(())
}
fn run(app: &AppHandle, apply: bool) -> Result<(), String> {
    let paths = app.state::<AppState>().paths.clone();
    let (archive, staging) = {
        let host = app.state::<ResourceAssistant>(); let job = host.0.lock().unwrap();
        (job.archive.clone().ok_or("未选择资源包")?, job.staging.clone())
    };
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(paths.tools_root.join("offline-resource-job.ps1"))
        .arg("-Archive").arg(archive).arg("-GatewayRoot").arg(&paths.app_root)
        .arg("-NativeExecutable").arg(&paths.gateway_executable).arg("-RuntimeRoot").arg(&paths.runtime_root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if apply {
        command.arg("-Apply");
        if let Some(staging) = staging { command.arg("-ResumeStaging").arg(staging); }
    }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|error| format!("无法启动资源安装：{error}"))?;
    {
        let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
        let input = child.stdin.take();
        if !job.cancelled { job.input = input; }
        if apply { job.snapshot["stage"] = "installing".into(); }
    }
    // Drain both pipes so diagnostic output cannot block a long installation.
    let stderr = child.stderr.take().ok_or("无法读取安装日志")?;
    let diagnostics = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr); let mut bytes = Vec::new();
        let _ = reader.by_ref().take(64 * 1024).read_to_end(&mut bytes);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let stdout = child.stdout.take().ok_or("无法读取安装进度")?;
    let mut outcome = None;
    let mut pipe_error = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                app.state::<ResourceAssistant>().0.lock().unwrap().input.take();
                pipe_error = Some(error.to_string()); break;
            }
        };
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue; };
        if record["type"] == "result" { outcome = Some(record); continue; }
        if record["type"] == "progress" {
            let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
            for key in ["phase", "done", "total"] { job.snapshot[key] = record[key].clone(); }
        }
    }
    let exit = child.wait().map_err(|error| error.to_string())?;
    let diagnostic = diagnostics.join().unwrap_or_default();
    if let Some(error) = pipe_error { return Err(format!("安装进度通道中断：{error} {diagnostic}")); }
    let record = outcome.ok_or_else(|| format!("安装进程未返回结果（{exit}）：{diagnostic}"))?;
    let host = app.state::<ResourceAssistant>(); let mut job = host.0.lock().unwrap();
    job.input.take(); job.busy = false;
    job.staging = if record["canResume"] == true { record["staging"].as_str().map(str::to_owned) } else { None };
    let success = exit.success() && record["error"].is_null() && record["result"]["ok"] == true
        && (!apply || record["result"]["kind"] == "huiyu-offline-import-result");
    if success {
        job.snapshot[if apply { "result" } else { "preview" }] = record["result"].clone();
        job.snapshot["stage"] = if apply { "completed" } else { "ready" }.into();
        job.snapshot["error"] = Value::Null;
    } else {
        job.snapshot["stage"] = if record["cancelled"] == true { "cancelled" } else { "failed" }.into();
        job.snapshot["error"] = record["error"].as_str().unwrap_or("资源安装未确认完成，请重试。").into();
        app.state::<AppState>().warn(&format!("resource assistant: {}", job.snapshot["error"]));
    }
    Ok(())
}
#[tauri::command]
pub fn resource_assistant_finish(app: AppHandle) -> Result<(), String> {
    let host = app.state::<ResourceAssistant>(); let job = host.0.lock().unwrap();
    if job.busy { return Err("请等待安装或取消完成。".into()); }
    if job.paused {
        let state = app.state::<AppState>();
        if state.paths.runtime_root.join("offline-install-pending.json").exists() {
            return Err("安装尚待恢复，请用同一资源包继续安装。".into());
        }
        crate::maintenance_protocol::write_json(&state.paths.config_root.join("resource-restart.json"), &true)?;
        state.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
        drop(job);
        app.request_restart();
    } else { drop(job); if let Some(window) = app.get_webview_window("resource-assistant") { let _ = window.close(); } }
    Ok(())
}
fn milliseconds() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
