//! Engine-independent execution results and durable task lifecycle hooks.

use crate::error::Result;
use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Debug)]
pub enum Output {
    Bytes {
        bytes: Arc<Vec<u8>>,
        mime: String,
    },
    File {
        path: PathBuf,
        mime: String,
        bytes: u64,
    },
}
impl Output {
    pub fn mime(&self) -> &str {
        match self {
            Self::Bytes { mime, .. } | Self::File { mime, .. } => mime,
        }
    }
    pub fn len(&self) -> u64 {
        match self {
            Self::Bytes { bytes, .. } => bytes.len() as u64,
            Self::File { bytes, .. } => *bytes,
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Each hook is awaited before the corresponding network side effect. Recovery
/// must observe the saved identity; it must never invoke submit automatically.
pub trait ExecutionHooks: Send + Sync {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>>;
    fn submitting(&self, provider: String, fingerprint: String) -> BoxFuture<'_, Result<()>>;
    fn observed(&self, id: String, metadata: Value) -> BoxFuture<'_, Result<()>>;
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>>;
    fn collect_indexed(&self, outputs: Vec<(usize, Output)>) -> BoxFuture<'_, Result<()>> {
        let _ = outputs;
        Box::pin(async {
            Err(crate::error::ApiError::new(
                501,
                "TASK_OUTPUT_INDEX_NOT_SUPPORTED",
                "当前任务持久层尚未接入分镜输出索引",
            ))
        })
    }
    fn protect_input(&self, name: String, input: Output) -> BoxFuture<'_, Result<()>> {
        let _ = (name, input);
        Box::pin(async {
            Err(crate::error::ApiError::new(
                501,
                "TASK_INPUT_NOT_SUPPORTED",
                "当前任务持久层尚未接入输入图像保护",
            ))
        })
    }
    fn restore_input(&self, name: String, path: PathBuf) -> BoxFuture<'_, Result<bool>> {
        let _ = (name, path);
        Box::pin(async { Ok(false) })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub status: String,
    pub settled: bool,
    pub unknown: bool,
    pub error_code: Option<String>,
    pub metadata: Value,
    #[serde(skip)]
    pub outputs: Vec<Output>,
}
