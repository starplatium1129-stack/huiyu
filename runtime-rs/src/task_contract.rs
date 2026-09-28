//! Durable task contract. JSON belongs at HTTP/provider and persistence boundaries;
//! lifecycle decisions use these types, independently of any engine or database.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Generation,
    Anima,
    Creative,
    Video,
    Batch,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultRef {
    pub alias: String,
    pub sha256: String,
    pub bytes: u64,
    pub mime: String,
    pub index: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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
    pub input: Map<String, Value>,
    pub input_media_refs: Vec<String>,
    pub result_state: ResultState,
    pub result_refs: Vec<ResultRef>,
    pub delivery_state: DeliveryState,
    pub error_code: Option<String>,
    pub metadata: Map<String, Value>,
    pub checkpoint: Option<Value>,
    pub parent_batch_id: Option<String>,
    pub step_index: Option<u64>,
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
    pub checkpoint: Option<Option<Value>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nonnull"
    )]
    pub input: Option<Map<String, Value>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TaskCommand {
    #[serde(rename = "task.get", rename_all = "camelCase")]
    Get {
        task_id: Option<String>,
        request_key: Option<String>,
    },
    #[serde(rename = "task.list")]
    List,
    #[serde(rename = "task.accept")]
    Accept { record: Box<TaskRecord> },
    #[serde(rename = "task.patch", rename_all = "camelCase")]
    Patch {
        task_id: String,
        expected_revision: i64,
        patch: Box<TaskPatch>,
    },
    #[serde(rename = "task.cancel", rename_all = "camelCase")]
    Cancel { request_key: String },
}
impl TaskCommand {
    pub fn is_read(&self) -> bool {
        matches!(self, Self::Get { .. } | Self::List)
    }
}
