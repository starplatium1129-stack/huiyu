use super::*;
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request},
    http::{HeaderMap, HeaderValue},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::{collections::HashMap, net::SocketAddr};

pub fn router(service: Arc<ControlService>) -> Router<crate::AppState> {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/share-link", get(share))
        .route("/api/logs", get(logs))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/config", post(config))
        .route("/api/preference", post(preference))
        .route("/api/start", post(start))
        .route("/api/stop", post(stop))
        .route("/api/service/{service}", post(action))
        .route("/api/mode", post(mode))
        .route("/api/maintenance/build-web", post(build))
        .layer(DefaultBodyLimit::max(8 * 1024))
        .layer(middleware::from_fn(local))
        .route("/api/sd-status", get(sd_status))
        .layer(Extension(service))
}
async fn local(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    if !crate::security::is_direct_local(&headers, peer.ip()) {
        return ApiError::new(403, "LOCAL_ONLY", "此操作仅限本机").into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
async fn status(
    Extension(s): Extension<Arc<ControlService>>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<Value> {
    let mut value = s.health(query.get("fresh").is_some_and(|v| v == "1")).await;
    let settings = s.config_view();
    let tunnel = s.remote.tunnel_url();
    for (key, item) in settings.as_object().unwrap() {
        value[key] = item.clone();
    }
    let operation = s.state.lock().unwrap().operation.clone();
    let mode_busy = operation.as_ref().is_some_and(|op| {
        op["status"] == "running" && op["kind"].as_str().is_some_and(|s| s.starts_with("mode-"))
    });
    for (key,item) in json!({"ok":true,"running":!s.shutdown.is_cancelled(),"modeBusy":mode_busy,"operation":operation,"localLink":format!("http://127.0.0.1:{}/",s.config.bind.port()),"shareLinkAvailable":!tunnel.is_empty(),"tunnelStatus":if !tunnel.is_empty(){"active"}else if s.tunnel_disabled(){"disabled"}else{"waiting"},"tunnelAvailable":!s.tunnel_disabled()&&s.tunnel_path().is_file(),"uptime":s.started.elapsed().as_secs(),"scripts":script_status(&s),"selfHealing":s.watchdog_status(),"webBuild":web_build(&s).await}).as_object().unwrap(){value[key]=item.clone();}
    Json(value)
}
fn script_status(s: &ControlService) -> Value {
    json!({"voiceStart":s.script(2,true).is_file(),"voiceStop":s.script(2,false).is_file(),"webui":s.script(0,true).is_file(),"comfy":s.script(1,true).is_file()})
}
async fn share(Extension(s): Extension<Arc<ControlService>>) -> Json<Value> {
    let tunnel = s.remote.tunnel_url();
    let link = if tunnel.is_empty() {
        String::new()
    } else {
        format!(
            "{}/?{}",
            tunnel,
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("token", &s.config.token)
                .finish()
        )
    };
    Json(json!({"ok":true,"shareLink":link}))
}
async fn logs(
    Extension(s): Extension<Arc<ControlService>>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<Value> {
    let since = query
        .get("since")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let (mut logs, total, operation) = {
        let state = s.state.lock().unwrap();
        let head = state.log_seq.saturating_sub(state.logs.len() as u64);
        let from = since.max(head).min(state.log_seq);
        (
            state
                .logs
                .iter()
                .skip((from - head) as usize)
                .cloned()
                .collect::<Vec<_>>(),
            state.log_seq,
            state.operation.clone(),
        )
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    for name in ["gateway.log", "tunnel.log", "control.log"] {
        let Ok(mut file) =
            tokio::fs::File::open(s.config.runtime_root.join("logs").join(name)).await
        else {
            continue;
        };
        let Ok(metadata) = file.metadata().await else {
            continue;
        };
        let start = metadata.len().saturating_sub(64 * 1024);
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            continue;
        }
        let mut bytes = Vec::new();
        if file.take(64 * 1024).read_to_end(&mut bytes).await.is_err() {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<_> = text.lines().filter(|line| !line.is_empty()).collect();
        logs.extend(
            lines
                .iter()
                .skip(lines.len().saturating_sub(30))
                .map(|line| s.redact(line)),
        );
    }
    Json(json!({"logs":logs,"total":total,"operation":operation}))
}
fn redact_config(s: &ControlService, value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let lower = k.to_ascii_lowercase();
                    (
                        k.clone(),
                        if [
                            "token",
                            "secret",
                            "password",
                            "credential",
                            "apikey",
                            "api_key",
                            "authorization",
                            "auth",
                            "cookie",
                            "prompt",
                            "messages",
                            "imagedata",
                        ]
                        .iter()
                        .any(|key| lower.contains(key))
                        {
                            json!("[redacted]")
                        } else {
                            redact_config(s, v)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => json!(
            items
                .iter()
                .map(|v| redact_config(s, v))
                .collect::<Vec<_>>()
        ),
        Value::String(text) => json!(s.redact(text)),
        other => other.clone(),
    }
}
async fn diagnostics(Extension(s): Extension<Arc<ControlService>>) -> Json<Value> {
    let mut value = s.settings();
    value["timestamp"] = json!(
        chrono::DateTime::from_timestamp_millis(now() as i64)
            .unwrap()
            .to_rfc3339()
    );
    value["uptime"] = json!(s.started.elapsed().as_secs());
    value["port"] = json!(s.config.bind.port());
    // Kept as the legacy wire field until the shared TS diagnostics schema is
    // versioned; empty states correctly that no Node interpreter runs here.
    value["nodeVersion"] = json!("");
    value["runtimeVersion"] = json!(concat!("rust-runtime/", env!("CARGO_PKG_VERSION")));
    value["platform"] = json!(if cfg!(windows) {
        "win32"
    } else {
        std::env::consts::OS
    });
    value["disableTunnel"] = json!(s.tunnel_disabled());
    value["runtimeConfig"] = redact_config(&s, &s.saved.read().unwrap());
    value["token"] = json!({"present":!s.config.token.is_empty(),"length":s.config.token.len(),"suffix":"[redacted]"});
    value["operation"] = json!(s.state.lock().unwrap().operation);
    value["scripts"] = json!({"voiceStart":s.script(2,true),"voiceStop":s.script(2,false),"webui":s.script(0,true),"comfy":s.script(1,true),"voiceStartExists":s.script(2,true).is_file(),"voiceStopExists":s.script(2,false).is_file(),"webuiExists":s.script(0,true).is_file(),"comfyExists":s.script(1,true).is_file()});
    value["sceneShowcaseDir"] = json!(
        std::env::var("SCENE_SHOWCASE_DIR")
            .ok()
            .or_else(|| s.saved.read().unwrap()["sceneShowcaseDir"]
                .as_str()
                .map(str::to_owned))
            .unwrap_or_default()
    );
    Json(value)
}
pub(super) fn validated_patch(body: Value) -> Result<Value> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("配置必须为对象"))?;
    let mut result = json!({});
    for (key, value) in object {
        match key.as_str() {
            "sdHost" | "comfyHost" | "ttsHost" | "ollamaHost" => {
                let raw = value
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("服务地址必须为字符串"))?;
                let url = crate::upstream::local_url(raw)
                    .map_err(|_| ApiError::invalid("服务地址只接受本机 HTTP"))?;
                result[key] = json!(url.origin().ascii_serialization());
            }
            "voices" if value.is_object() => result[key] = value.clone(),
            "autoStartVoice" if value.is_boolean() => result[key] = value.clone(),
            _ => return Err(ApiError::invalid(format!("不支持的配置字段或类型：{key}"))),
        }
    }
    Ok(result)
}
async fn config(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let mut value = s.patch(validated_patch(body)?).await?;
    value["ok"] = json!(true);
    Ok(Json(value))
}
async fn preference(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let enabled = body["autoStartVoice"]
        .as_bool()
        .ok_or_else(|| ApiError::invalid("autoStartVoice 必须为布尔值"))?;
    s.patch(json!({"autoStartVoice":enabled})).await?;
    Ok(Json(json!({"ok":true,"autoStartVoice":enabled})))
}
async fn action(
    Extension(s): Extension<Arc<ControlService>>,
    Path(service): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let action = body["action"].as_str().unwrap_or("");
    if !matches!(service.as_str(), "webui" | "comfy" | "voice" | "ollama")
        || if service == "ollama" {
            action != "unload"
        } else {
            !matches!(action, "start" | "stop")
        }
    {
        return Err(ApiError::invalid("不支持的服务操作"));
    }
    Ok(Json(s.launch(format!("{service}-{action}"))?))
}
async fn mode(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let mode = body["mode"].as_str().unwrap_or("");
    if !matches!(mode, "draw" | "chat") {
        return Err(ApiError::invalid("mode 必须是 draw 或 chat"));
    }
    Ok(Json(s.launch(format!("mode-{mode}"))?))
}
async fn start(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    if body["enableTunnel"] == false {
        return Ok(Json(json!({"ok":true,"message":"公网分享保持关闭"})));
    }
    s.start_tunnel().await?;
    Ok(Json(json!({"ok":true,"message":"公网分享通道已请求启动"})))
}
async fn stop(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    s.stop_tunnel_request(true).await?;
    Ok(Json(json!({"ok":true,"message":"公网分享通道已停止"})))
}
async fn web_build(s: &ControlService) -> Value {
    let mut cache = s.build_cache.lock().await;
    if let Some((at, value)) = cache.as_ref()
        && at.elapsed() < Duration::from_secs(30)
    {
        return value.clone();
    }
    let root = s.config.app_root.clone();
    let value=tokio::task::spawn_blocking(move||{
        let built=std::fs::metadata(root.join("dist/index.html")).ok().and_then(|m|m.modified().ok());
        let mut newest=UNIX_EPOCH;let mut stack=vec![root.join("src"),root.join("public"),root.join("index.html"),root.join("vite.config.ts")];let mut count=0;
        while let Some(path)=stack.pop(){count+=1;if count>50000{break;}let Ok(meta)=std::fs::symlink_metadata(&path)else{continue};if meta.file_type().is_symlink(){continue;}
if meta.is_dir(){if let Ok(entries)=std::fs::read_dir(path){stack.extend(entries.filter_map(|e|e.ok().map(|e|e.path())));}}else if let Ok(modified)=meta.modified(){newest=newest.max(modified);}}
        let timestamp=|time:SystemTime|chrono::DateTime::from_timestamp_millis(time.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64).map(|t|t.to_rfc3339());
        json!({"distReady":built.is_some(),"builtAt":built.and_then(timestamp),"stale":built.is_some_and(|t|newest.duration_since(t).is_ok_and(|d|d>Duration::from_secs(5))),"sourceNewest":timestamp(newest)})
    }).await.unwrap_or(json!({"distReady":false,"builtAt":null,"stale":false,"sourceNewest":null}));
    *cache = Some((Instant::now(), value.clone()));
    value
}
async fn build(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    if std::env::var("AICS_DESKTOP_PACKAGED").as_deref() == Ok("1") {
        return Err(ApiError::new(
            501,
            "DESKTOP_MAINTENANCE_UNAVAILABLE",
            "桌面应用模式不包含构建工具，请在源码环境构建",
        ));
    }
    let op = s.begin("build-web", &["正在构建前端"])?;
    let started = Instant::now();
    // Fixed arguments only; no request data is ever interpreted by the shell.
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.args(["/d", "/s", "/c", "npm run build"]);
        c
    } else {
        let mut c = tokio::process::Command::new("npm");
        c.args(["run", "build"]);
        c
    };
    command
        .current_dir(&s.config.app_root)
        .env("NODE_ENV", "production")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let service = s.clone();
    let operation = op.clone();
    let task = s.tasks.spawn(async move {
        let result = service.run_command(command, 600).await.map(|_| ());
        let error = result
            .as_ref()
            .err()
            .map(|e| (e.status.as_u16(), e.code.clone(), e.message.clone()));
        service.finish(&operation, result);
        error
    });
    if let Some((status, code, message)) = task
        .await
        .map_err(|_| ApiError::new(503, "BUILD_FAILED", "构建任务异常退出"))?
    {
        return Err(ApiError::new(status, code, message));
    }
    *s.build_cache.lock().await = None;
    Ok(Json(
        json!({"ok":true,"durationMs":started.elapsed().as_millis(),"tail":"","webBuild":web_build(&s).await}),
    ))
}
async fn sd_status(Extension(s): Extension<Arc<ControlService>>) -> Response {
    let host = s.settings()["sdHost"].as_str().unwrap_or("").to_string();
    let (models, samplers, schedulers, upscalers, options) = tokio::join!(
        s.request(&host, "/sdapi/v1/sd-models", None, 5),
        s.request(&host, "/sdapi/v1/samplers", None, 5),
        s.request(&host, "/sdapi/v1/schedulers", None, 5),
        s.request(&host, "/sdapi/v1/upscalers", None, 5),
        s.request(&host, "/sdapi/v1/options", None, 5)
    );
    let online = models
        .as_ref()
        .is_ok_and(|(status, _, _)| (200..300).contains(status));
    let names = |response: Result<(u16, Option<Value>, String)>, keys: &[&str]| -> Vec<Value> {
        response
            .ok()
            .and_then(|(_, v, _)| v)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|value| {
                keys.iter()
                    .find_map(|key| {
                        value
                            .get(*key)
                            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                            .cloned()
                    })
                    .or_else(|| value.as_str().filter(|s| !s.is_empty()).map(|s| json!(s)))
            })
            .collect()
    };
    let value = json!({"online":online,"host":host,"models":if online{names(models,&["title","model_name","name"])}else{vec![]},"samplers":names(samplers,&["name"]),"schedulers":names(schedulers,&["name","label"]),"upscalers":names(upscalers,&["name"]),"checkpoint":options.ok().and_then(|(_,v,_)|v).and_then(|v|v["sd_model_checkpoint"].as_str().map(str::to_owned)).unwrap_or_default(),"error":if online{String::new()}else{format!("SD WebUI 未响应（{host}）")}});
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
