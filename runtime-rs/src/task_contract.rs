//! Durable task contract. JSON belongs at HTTP/provider and persistence boundaries;
//! lifecycle decisions use these types, independently of any engine or database.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Generation,
    Anima,
    Creative,
    Qwen,
    Moss,
    Manga,
    Lineart,
    Video,
    Batch,
}
impl TaskKind {
    pub fn is_manga(self) -> bool {
        matches!(self, Self::Manga | Self::Lineart)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Submitting,
    Running,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
}
impl TaskStatus {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryState {
    Normal,
    Reconciling,
    Unknown,
    Interrupted,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultState {
    None,
    Collecting,
    Available,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryState {
    Unseen,
    Seen,
    Saved,
    Discarded,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultRef {
    pub alias: String,
    pub sha256: String,
    pub bytes: u64,
    pub mime: String,
    pub index: u64,
}
impl ResultRef {
    fn into_value(self) -> Value {
        let mut value = json!({
            "alias": null, "sha256": null, "bytes": self.bytes,
            "mime": null, "index": self.index,
        });
        value["alias"] = Value::String(self.alias);
        value["sha256"] = Value::String(self.sha256);
        value["mime"] = Value::String(self.mime);
        value
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRecord {
    pub task_id: String,
    pub workspace_id: String,
    pub principal_id: String,
    pub request_key: String,
    pub request_fingerprint: String,
    // Records predating the locale fingerprint codec have no locale field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_fingerprint_locale: Option<String>,
    pub kind: TaskKind,
    pub provider: String,
    pub provider_fingerprint: String,
    pub upstream_id: Option<String>,
    pub status: TaskStatus,
    pub recovery_state: RecoveryState,
    pub revision: i64,
    pub runtime_epoch: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub submission_intent_at: Option<u64>,
    pub submission_observed_at: Option<u64>,
    pub cancel_requested_at: Option<u64>,
    pub upstream_settled: bool,
    pub execution_deadline: u64,
    // Shared payloads are immutable across the runtime/worker boundary.
    pub input: Arc<Map<String, Value>>,
    pub input_media_refs: Vec<String>,
    pub result_state: ResultState,
    pub result_refs: Vec<ResultRef>,
    pub delivery_state: DeliveryState,
    pub error_code: Option<String>,
    pub metadata: Map<String, Value>,
    pub checkpoint: Option<Arc<Value>>,
    pub parent_batch_id: Option<String>,
    pub step_index: Option<u64>,
}

impl TaskRecord {
    pub fn can_retry_manga(&self) -> bool {
        self.kind.is_manga()
            && self.provider == "native"
            && self.status == TaskStatus::Failed
            && self.upstream_settled
            && self.recovery_state == RecoveryState::Normal
            && self.cancel_requested_at.is_none()
    }
    /// Manga pages may also own a line sidecar; an extracted line is output 0.
    pub fn manga_result_count(&self) -> Option<u64> {
        self.kind.is_manga().then(|| {
            if self.kind == TaskKind::Manga
                && (self.input.get("autoLines") == Some(&Value::Bool(true))
                    || self.input.get("penLines").is_some_and(Value::is_string))
            {
                2
            } else {
                1
            }
        })
    }

    pub(crate) fn into_value(mut self) -> serde_json::Result<Value> {
        // Move unique trees; shared payloads detach only at the JSON boundary.
        let input = std::mem::take(&mut self.input);
        let input_media_refs = std::mem::take(&mut self.input_media_refs);
        let result_refs = std::mem::take(&mut self.result_refs);
        let metadata = std::mem::take(&mut self.metadata);
        let checkpoint = self.checkpoint.take();
        let mut value = serde_json::to_value(self)?;
        value["input"] = Value::Object(Arc::unwrap_or_clone(input));
        value["inputMediaRefs"] = Value::Array(input_media_refs.into_iter().map(Value::String).collect());
        value["resultRefs"] = Value::Array(result_refs.into_iter().map(ResultRef::into_value).collect());
        value["metadata"] = Value::Object(metadata);
        value["checkpoint"] = checkpoint.map(Arc::unwrap_or_clone).unwrap_or(Value::Null);
        Ok(value)
    }
}

/// Validated list projection. Recipes and checkpoints are available only in task detail reads.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSummary {
    pub task_id: String,
    pub workspace_id: String,
    pub principal_id: String,
    pub request_key: String,
    pub kind: TaskKind,
    pub provider: String,
    pub upstream_id: Option<String>,
    pub status: TaskStatus,
    pub recovery_state: RecoveryState,
    pub revision: i64,
    pub runtime_epoch: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub submission_intent_at: Option<u64>,
    pub submission_observed_at: Option<u64>,
    pub cancel_requested_at: Option<u64>,
    pub upstream_settled: bool,
    pub execution_deadline: u64,
    pub result_state: ResultState,
    pub result_refs: Vec<ResultRef>,
    pub delivery_state: DeliveryState,
    pub error_code: Option<String>,
    pub parent_batch_id: Option<String>,
    pub step_index: Option<u64>,
    pub source_batch_id: Option<String>,
    pub can_concat: bool,
    pub retry_of_task_id: Option<String>,
    pub retry_task_id: Option<String>,
}
impl TaskSummary {
    pub(crate) fn into_value(mut self) -> serde_json::Result<Value> {
        let result_refs = std::mem::take(&mut self.result_refs);
        let mut value = serde_json::to_value(self)?;
        value["resultRefs"] = Value::Array(result_refs.into_iter().map(ResultRef::into_value).collect());
        Ok(value)
    }
}

// An absent patch leaves a nullable field untouched; explicit null clears it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
fn nonnull<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskPatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub status: Option<TaskStatus>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub recovery_state: Option<RecoveryState>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub upstream_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub provider: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub provider_fingerprint: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub submission_intent_at: Option<Option<u64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub submission_observed_at: Option<Option<u64>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub upstream_settled: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub result_state: Option<ResultState>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub delivery_state: Option<DeliveryState>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub error_code: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub checkpoint: Option<Option<Arc<Value>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub input: Option<Arc<Map<String, Value>>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskListQuery {
    pub before: Option<i64>,
    pub after_revision: Option<i64>,
    pub through_revision: Option<i64>,
    pub limit: Option<u32>,
    #[serde(default)]
    pub recoverable: bool,
    #[serde(default)]
    pub summary: bool,
    #[serde(default)]
    pub scope: TaskListScope,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskListScope {
    #[default]
    All,
    Overview,
    Open,
    Attention,
    Inbox,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TaskCommand {
    #[serde(rename = "task.get", rename_all = "camelCase")]
    Get {
        task_id: Option<String>,
        request_key: Option<String>,
        #[serde(default)]
        summary: bool,
    },
    #[serde(rename = "task.list")]
    List {
        #[serde(flatten)]
        query: TaskListQuery,
    },
    #[serde(rename = "task.accept", rename_all = "camelCase")]
    Accept {
        record: Box<TaskRecord>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_of: Option<String>,
    },
    #[serde(rename = "task.patch", rename_all = "camelCase")]
    Patch {
        task_id: String,
        expected_revision: i64,
        patch: Box<TaskPatch>,
    },
    #[serde(rename = "task.cancel", rename_all = "camelCase")]
    Cancel { request_key: String },
    #[serde(rename = "task.resolve-webui", rename_all = "camelCase")]
    ResolveWebui {
        task_id: String,
        expected_revision: i64,
        upstream_stopped: bool,
    },
}
impl TaskCommand {
    pub fn is_read(&self) -> bool {
        matches!(self, Self::Get { .. } | Self::List { .. })
    }
}
