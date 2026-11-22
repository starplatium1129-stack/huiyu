use super::*;
use crate::{native_python, processes::Processes};
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub(super) async fn compose(
    storage: &Storage,
    owner: &str,
    token: &CancellationToken,
    request: &Value,
    python: &Path,
    script: &Path,
) -> Result<Value> {
    let mut cmd = native_python::command(python, script);
    cmd.arg("--serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let pool = Arc::new(Processes::default());
    let child = pool.spawn(&mut cmd)?;
    #[cfg(windows)]
    let tree = child.own_worker_tree()?;
    let mut input = child
        .take_input()
        .ok_or_else(|| ApiError::invalid("导出器输入未打开"))?;
    let mut reader = BufReader::new(
        child
            .take_output()
            .0
            .ok_or_else(|| ApiError::invalid("导出器输出未打开"))?,
    );
    let id = text(request, "id")?;
    let mut payload = serde_json::to_vec(request)?;
    payload.push(b'\n');
    let result = async {
        input.write_all(&payload).await?;
        input.flush().await?;
        let mut last: Option<(String, tokio::time::Instant)> = None;
        loop {
            let mut line = Vec::new();
            (&mut reader)
                .take(65537)
                .read_until(b'\n', &mut line)
                .await?;
            if line.len() > 65536 || !line.ends_with(b"\n") {
                return Err(ApiError::new(
                    502,
                    "EXPORT_WORKER_EXIT",
                    "本地导出器已退出或响应不完整",
                ));
            }
            let event: Value = serde_json::from_slice(&line)?;
            if event["id"] != id {
                return Err(ApiError::invalid("导出器返回的任务编号不匹配"));
            }
            match event["event"].as_str() {
                Some("progress") => {
                    let stage = match event["stage"].as_str() {
                        Some("probe") => "正在读取片段",
                        Some("normalize") => "正在统一画幅和帧率",
                        Some("dependencies") => "正在加载 CPU 增强组件",
                        Some("decode") => "正在拆分镜头画面",
                        Some("audio") => "正在对齐配音",
                        Some("upscale") => "正在超分辨率放大",
                        Some("interpolate" | "rife") => "正在插帧",
                        Some("copy") => "正在复制原始画面",
                        Some("concat") => "正在拼接镜头",
                        Some("verify") => "正在核对成片",
                        _ => "正在处理镜头",
                    };
                    let message = match (event["index"].as_u64(), event["total"].as_u64()) {
                        (Some(i), Some(n)) if i > 0 && n >= i => format!("{stage}（{i}/{n}）"),
                        _ => stage.into(),
                    };
                    if last.as_ref().is_some_and(|(msg, t)| {
                        msg == &message && t.elapsed() < Duration::from_millis(750)
                    }) {
                        continue;
                    }
                    let progress = event["value"]
                        .as_f64()
                        .filter(|n| (0.0..=1.0).contains(n))
                        .map(|n| n * 0.99);
                    let row = storage.request(json!({"kind":"studio.exportProgress","id":id,"message":message,"progress":progress}),owner).await?;
                    if row["cancelRequested"] == true {
                        return Err(cancelled());
                    }
                    last = Some((message, tokio::time::Instant::now()));
                }
                Some("result") => {
                    // Windows may expand a short TEMP path in the Python receipt.
                    let output = tokio::fs::canonicalize(text(request, "outputPath")?).await?;
                    if output != tokio::fs::canonicalize(text(&event, "outputPath")?).await? {
                        return Err(ApiError::invalid("导出器返回了其他文件"));
                    }
                    let meta = &event["metadata"];
                    let mut facts = json!({});
                    for field in [
                        "width",
                        "height",
                        "fps",
                        "frames",
                        "duration",
                        "hasAudio",
                        "videoCodec",
                        "audioCodec",
                        "videoMode",
                        "audioMode",
                        "upscaler",
                        "interpolator",
                        "sha256",
                        "bytes",
                    ] {
                        facts[field] = meta[field].clone();
                    }
                    return Ok(facts);
                }
                Some("cancelled") => return Err(cancelled()),
                Some("error") => {
                    return Err(ApiError::new(
                        422,
                        "STUDIO_EXPORT_FAILED",
                        event["message"].as_str().unwrap_or("本地成片导出失败"),
                    ));
                }
                _ => return Err(ApiError::invalid("导出器响应无效")),
            }
        }
    };
    let outcome = tokio::select! {
        res = result => res,
        _ = token.cancelled() => Err(cancelled()),
        _ = tokio::time::sleep(Duration::from_secs(6*60*60)) => Err(ApiError::new(504,"STUDIO_EXPORT_TIMEOUT","导出已超时，可分批导出所选镜头")),
    };
    if outcome.is_err() {
        let _ = tokio::time::timeout(
            Duration::from_millis(200),
            input.write_all(format!("{}\n", json!({"op":"cancel","id":id})).as_bytes()),
        )
        .await;
    }
    drop(input);
    // Give the helper time to close FFmpeg and remove its temporary frames.
    for _ in 0..20 {
        if child.exited()?.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    #[cfg(windows)]
    tree.retire().await?;
    child.stop().await?;
    outcome
}
