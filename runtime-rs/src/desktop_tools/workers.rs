use super::{Error, Result, commands, files, paths, text};
use axum::{
    body::Bytes,
    http::header::CONTENT_TYPE,
    response::{IntoResponse, Response},
};
use base64::{display::Base64Display, engine::general_purpose::STANDARD};
use serde::{Serialize, Serializer};
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};
use tokio_util::{
    sync::CancellationToken,
    task::{TaskTracker, task_tracker::TaskTrackerToken},
};

pub(super) struct Workers {
    listings: Arc<Semaphore>,
    images: Arc<Semaphore>,
    active: TaskTracker,
    closed: Mutex<bool>,
}
impl Workers {
    pub fn new() -> Self {
        Self {
            listings: Arc::new(Semaphore::new(4)),
            images: Arc::new(Semaphore::new(2)),
            active: TaskTracker::new(),
            closed: Mutex::new(false),
        }
    }
    fn track(&self, cancel: &CancellationToken) -> Result<TaskTrackerToken> {
        let closed = self.closed.lock().unwrap();
        if *closed || cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        // Registration and close share a lock; disconnected workers remain tracked.
        Ok(self.active.token())
    }
    pub async fn list(
        &self,
        root: &Path,
        input: &Value,
        shutdown: &CancellationToken,
    ) -> Result<Value> {
        let cancel = shutdown.child_token();
        let _cancel = cancel.clone().drop_guard();
        let directory = paths::resolve(root, &text(&input["path"])).await?;
        let permit = tokio::select! { biased;
            _ = cancel.cancelled() => return Err(Error::cancelled()),
            permit = self.listings.clone().acquire_owned() => permit.map_err(|_| Error::cancelled())?,
        };
        let tracked = self.track(&cancel)?;
        tokio::task::spawn_blocking(move || {
            let (_tracked, _permit) = (tracked, permit);
            files::list_directory(&directory, &cancel)
        })
        .await
        .map_err(|_| Error::plain("目录读取未完成"))?
    }
    pub fn image_permit(&self, cancel: &CancellationToken) -> Result<Arc<OwnedSemaphorePermit>> {
        let closed = self.closed.lock().unwrap();
        if *closed || cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        // Screen capture has a 15-second client deadline. Do not queue behind
        // slow response bodies before starting its existing 10-second operation.
        self.images
            .clone()
            .try_acquire_owned()
            .map(Arc::new)
            .map_err(|error| match error {
                TryAcquireError::NoPermits => {
                    Error::coded("TOOL_BUSY", "图片工具正在处理其他请求，请稍后重试")
                }
                TryAcquireError::Closed => {
                    Error::coded("TOOL_UNAVAILABLE", "图片工具当前不可用，请重启网关后重试")
                }
            })
    }
    pub async fn encode(
        &self,
        input: Image,
        permit: Arc<OwnedSemaphorePermit>,
        cancel: &CancellationToken,
    ) -> Result<Response> {
        let tracked = self.track(cancel)?;
        let worker_cancel = cancel.clone();
        let work = tokio::task::spawn_blocking(move || {
            let _tracked = tracked;
            if worker_cancel.is_cancelled() {
                return Err(Error::cancelled());
            }
            let bytes = input.encode()?;
            if worker_cancel.is_cancelled() {
                return Err(Error::cancelled());
            }
            // Only the permit follows the response, so a slow client cannot
            // prevent close from waiting for actual blocking work to finish.
            Ok(Bytes::from_owner(ImageBody {
                bytes,
                _permit: permit,
            }))
        });
        let bytes = tokio::select! { biased;
            _ = cancel.cancelled() => return Err(Error::cancelled()),
            result = work => result.map_err(|_| Error::plain("图片响应未完成"))??,
        };
        Ok(([(CONTENT_TYPE, "application/json")], bytes).into_response())
    }
    pub async fn close(&self) {
        {
            let mut closed = self.closed.lock().unwrap();
            *closed = true;
            self.listings.close();
            self.images.close();
            self.active.close();
        }
        self.active.wait().await;
    }
}

struct ImageBody {
    bytes: Vec<u8>,
    _permit: Arc<OwnedSemaphorePermit>,
}
impl AsRef<[u8]> for ImageBody {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
pub(super) enum Image {
    File {
        bytes: Vec<u8>,
        mime: &'static str,
        relative: String,
    },
    Screen(commands::Output),
}
impl Image {
    fn encode(self) -> Result<Vec<u8>> {
        match self {
            Self::File {
                bytes,
                mime,
                relative,
            } => image_json(
                &format!(
                    "已读取图片 {}（{} B，{}）",
                    relative,
                    bytes.len(),
                    mime.trim_start_matches("image/")
                ),
                DataUrl::File(mime, &bytes),
            ),
            Self::Screen(output) => {
                let (stdout, _) = output.text()?;
                let base64 = stdout.trim();
                if base64.is_empty() {
                    return Err(Error::plain("未捕获到屏幕数据"));
                }
                image_json(
                    &format!(
                        "已成功捕获当前桌面屏幕画面（{} KB JPEG）",
                        (base64.len() as f64 * 0.75 / 1024.0).round() as u64
                    ),
                    DataUrl::Screen(base64),
                )
            }
        }
    }
}
enum DataUrl<'a> {
    File(&'static str, &'a [u8]),
    Screen(&'a str),
}
impl Serialize for DataUrl<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        // collect_str writes each chunk through JSON escaping into the final
        // response Vec; no full base64 String, data URL String or Value clone.
        match self {
            Self::File(mime, bytes) => serializer.collect_str(&format_args!(
                "data:{mime};base64,{}",
                Base64Display::new(bytes, &STANDARD)
            )),
            Self::Screen(base64) => {
                serializer.collect_str(&format_args!("data:image/jpeg;base64,{base64}"))
            }
        }
    }
}
fn image_json(output: &str, image_data_url: DataUrl<'_>) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    struct Payload<'a> {
        ok: bool,
        output: &'a str,
        #[serde(rename = "imageDataUrl")]
        image_data_url: DataUrl<'a>,
    }
    // Inputs are bounded to 8 MiB files or 20 MiB combined command output.
    // Reserve the normal encoded size; JSON escaping can still grow the Vec.
    let size = match &image_data_url {
        DataUrl::File(mime, bytes) => {
            base64::encoded_len(bytes.len(), true).unwrap() + mime.len() + 13
        }
        DataUrl::Screen(base64) => base64.len() + 23,
    };
    let mut bytes = Vec::with_capacity(size + output.len() + 64);
    serde_json::to_writer(
        &mut bytes,
        &Payload {
            ok: true,
            output,
            image_data_url,
        },
    )
    .map_err(|_| Error::plain("图片响应未完成"))?;
    Ok(bytes)
}
