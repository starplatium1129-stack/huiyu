//! Restart observations only: never replay an accepted native execution.
use super::*;
use crate::execution::Observation;

pub(super) async fn recover(
    storage: &Storage,
    principal: &str,
    task: &TaskRecord,
) -> Result<Observation> {
    let count = task.manga_result_count().unwrap_or(1);
    let complete = (0..count).all(|index| task.result_refs.iter().any(|item| item.index == index));
    let recorded = task
        .checkpoint
        .as_ref()
        .and_then(|value| value["mangaResultMetadata"].as_object());
    let mut metadata = task.metadata.clone();
    if let Some(recorded) = recorded {
        metadata.extend(recorded.clone());
    }
    let (status, settled, code) = if complete && recorded.is_some() {
        metadata.insert("resultCollectionError".into(), Value::Null);
        ("succeeded", true, None)
    } else if task.cancel_requested_at.is_some() {
        ("cancelled", true, None)
    } else if task.submission_intent_at.is_none() {
        ("queued", false, Some("TASK_AWAITING_RESUME"))
    } else {
        (
            "failed",
            true,
            Some(if task.result_refs.is_empty() {
                "NATIVE_RESTART_INTERRUPTED"
            } else {
                "MANGA_RESULT_INCOMPLETE"
            }),
        )
    };
    if settled && !task.result_refs.is_empty() && task.result_state != ResultState::Available {
        // Preserve any committed artifact when its sibling was interrupted.
        // The failed status/message continues to disclose incomplete delivery.
        patch(
            storage,
            principal,
            &task.task_id,
            TaskPatch {
                result_state: Some(ResultState::Available),
                ..Default::default()
            },
        )
        .await?;
    }
    Ok(Observation {
        status: status.into(),
        settled,
        unknown: false,
        error_code: code.map(str::to_owned),
        metadata: Value::Object(metadata),
        outputs: vec![],
    })
}
