use super::*;

/** Mirrors the image result contract: recorded provider facts override recipe inputs. */
pub(super) async fn save(storage: &Storage, principal: &str, task: &TaskRecord) -> Result<(String, String)> {
    let task_value = serde_json::to_value(task)?;
    let output = task_value["resultRefs"].as_array().and_then(|items| items.iter().find(|item| item["index"] == 0 && item["mime"].as_str().is_some_and(|mime| mime.starts_with("image/"))))
        .ok_or_else(|| ApiError::invalid("Batch image result is unavailable"))?;
    let alias = output["alias"].as_str().ok_or_else(|| ApiError::invalid("Missing output alias"))?.to_owned();
    let id = format!("task-{}-0", task.task_id);
    let existing = storage.request(json!({"kind":"getArtwork","id":id}), principal).await?;
    if !existing.is_null() {
        if !existing["deletedAt"].is_null() { return Err(ApiError::new(409,"ARTWORK_DELETED","该作品已移入回收站，请先恢复原作品再核对批次。")); }
        if existing["body"]["image_id"] == alias || existing["image_id"] == alias { return Ok((id,alias)); }
        return Err(ApiError::invalid("Batch artwork identity belongs to another image"));
    }
    let context = &task.metadata["context"];
    let mut record = context["history"].as_object().cloned().unwrap_or_default();
    let mut actual = task.input.as_ref().clone();
    actual.extend(task.metadata.clone());
    for key in ["engine","provider","profile","model","checkpoint","seed","size","prompt","negative","cfg","steps","sampler","scheduler","lora","loraId","loraStrength","loras","styleLoraId","preview","hiresFix","hiresScale","hiresUpscaler","hiresSteps","hiresDenoise","faceDetailer"] { record.remove(key); }
    for key in ["prompt","negative","seed","cfg","steps","sampler","scheduler","loraId","loraStrength","loras","styleLoraId","preview","hiresFix","hiresScale","hiresUpscaler","hiresSteps","hiresDenoise","faceDetailer","sketchControl","sketchControlModel","regions"] {
        if key == "seed" && actual.get(key).is_none_or(|seed| seed.as_u64().is_none()) { continue; }
        if let Some(value) = actual.get(key) { record.insert(key.into(), value.clone()); }
    }
    for (from,to) in [("profileId","profile"),("modelId","model"),("modelId","checkpoint"),("loraId","lora")] {
        if let Some(value) = actual.get(from) { record.insert(to.into(),value.clone()); }
    }
    if let (Some(width),Some(height)) = (actual.get("width").and_then(Value::as_u64),actual.get("height").and_then(Value::as_u64)) {
        record.insert("size".into(),json!(format!("{width}x{height}")));
    }
    for (key,value) in [
        ("id",json!(id)),("image_id",json!(alias)),("timestamp",json!(task.created_at)),
        ("engine",json!(if task.kind == TaskKind::Creative {"krea2"}else{"anima"})),
        ("provider",json!(task.provider)),("taskId",json!(task.task_id)),("outputIndex",json!(0)),
        ("favorite",json!(false)),("rating",json!({})),("version",json!(1)),
    ] { record.insert(key.into(),value); }
    storage.request(json!({"kind":"appendArtwork","operationId":format!("batch-artwork:{}",task.task_id),"artwork":record}), principal).await?;
    Ok((id,alias))
}
