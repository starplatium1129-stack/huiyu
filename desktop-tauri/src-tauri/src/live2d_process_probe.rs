//! JSONL acceptance host, available only in an explicitly isolated PoC process.
//! Uses the same supervisor and job as Tauri; it is never a WebView capability.
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::Deserialize;
use serde_json::{json, Value};
use crate::live2d_process::{self as process, EventSink};
use crate::live2d_process_protocol::Command;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeRequest {
    id: u64,
    op: String,
    assets_root: Option<String>,
    local_root: Option<String>,
    command: Option<Command>,
    timeout_ms: Option<u64>,
}

type Output = Arc<Mutex<std::io::Stdout>>;

fn write(output: &Output, message: Value) {
    let mut output = output.lock().unwrap();
    if serde_json::to_writer(&mut *output, &message).is_ok() {
        let _ = output.write_all(b"\n").and_then(|_| output.flush());
    }
}

fn reply(output: &Output, id: u64, result: Result<Value, String>) {
    write(output, json!({"type": "reply", "id": id, "result": result}));
}

fn status() -> Value {
    process::current().map(|child| child.diagnostics())
        .unwrap_or_else(|| json!({"alive": false, "childPid": null, "generation": null, "pending": 0}))
}

pub fn run() -> Result<(), String> {
    if !process::enabled() { return Err("probe host requires an explicit isolated profile".into()); }
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let events = output.clone();
    let emit: EventSink = Arc::new(move |name, payload| {
        write(&events, json!({"type": "event", "name": name, "payload": payload}));
    });
    let mut input = BufReader::new(std::io::stdin());
    while let Some(line) = process::read_line(&mut input)? {
        let request = serde_json::from_slice::<ProbeRequest>(&line).map_err(|e| e.to_string())?;
        match request.op.as_str() {
            "start" => {
                let result = match request.assets_root.map(PathBuf::from).filter(|path| path.is_absolute()) {
                    Some(assets) => tauri::async_runtime::block_on(process::get_or_start(
                        assets, request.local_root.map(PathBuf::from), emit.clone()))
                        .map(|child| child.diagnostics()),
                    None => Err("start requires an absolute assets_root".into()),
                };
                reply(&output, request.id, result);
            }
            "call" => {
                let output = output.clone();
                tauri::async_runtime::spawn(async move {
                    let result = match (process::current(), request.command) {
                        (Some(child), Some(command)) => {
                            let result = child.call(command, Duration::from_millis(
                                request.timeout_ms.unwrap_or(10_000).clamp(1, 60_000))).await;
                            result.map(|value| json!({"value": value, "rendererProcess": child.diagnostics()}))
                        }
                        (_, None) => Err("call requires command".into()),
                        _ => Err("renderer not attached; explicit start required".into()),
                    };
                    reply(&output, request.id, result);
                });
            }
            "kill" => {
                if let Some(child) = process::current() { child.stop("probe requested renderer termination"); }
                reply(&output, request.id, Ok(status()));
            }
            "status" => reply(&output, request.id, Ok(status())),
            "exit" => { process::shutdown(); reply(&output, request.id, Ok(status())); return Ok(()); }
            "abandon" => {
                reply(&output, request.id, Ok(status()));
                // Deliberately bypass Rust destructors to verify OS kill-on-close.
                std::process::exit(0);
            }
            _ => reply(&output, request.id, Err("unknown probe operation".into())),
        }
    }
    process::shutdown();
    Ok(())
}
