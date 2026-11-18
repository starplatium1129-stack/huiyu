use super::*;

#[derive(serde::Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Recent {
    since: Option<String>,
    before: Option<String>,
    limit: Option<u32>,
}

pub(super) async fn recent(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Query(input): Query<Recent>,
) -> Response {
    if let Some(response) = muse.search_limit.check(false) {
        return response;
    }
    let result = async {
        state.host.check_running()?;
        let limit = input.limit.unwrap_or(30);
        if !(1..=100).contains(&limit) {
            return Err(ApiError::invalid("limit 须为 1–100"));
        }
        let time = |value: &str| {
            value
                .parse::<i64>()
                .ok()
                .or_else(|| {
                    chrono::DateTime::parse_from_rfc3339(value)
                        .ok()
                        .map(|date| date.timestamp_millis())
                })
                .filter(|value| *value >= 0)
                .ok_or_else(|| ApiError::invalid("时间须为 Unix 毫秒或 RFC3339 日期"))
        };
        let since = input.since.as_deref().map(time).transpose()?.unwrap_or(0);
        let cursor = input
            .before
            .as_deref()
            .map(|value| {
                let invalid = || ApiError::invalid("before 须使用上一页返回的 nextBefore");
                let (timestamp, suffix) = value.split_once(':').ok_or_else(invalid)?;
                let (kind, id) = suffix.split_once(':').unwrap_or(("job", suffix));
                let valid = match kind {
                    "job" => id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()),
                    "batch" => {
                        !id.is_empty()
                            && id.len() <= 160
                            && id
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                    }
                    _ => false,
                };
                if !valid {
                    return Err(invalid());
                }
                Ok((time(timestamp)?, format!("{kind}:{id}")))
            })
            .transpose()?;
        let store = muse.store()?;
        let mut items = store.recent(since, cursor, limit + 1).await?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next = if has_more {
            items.last().and_then(|item| {
                let kind = if item["entryType"] == "batch" {
                    "batch"
                } else {
                    "job"
                };
                Some(format!(
                    "{}:{kind}:{}",
                    item["createdAt"].as_i64()?,
                    item["id"].as_str()?
                ))
            })
        } else {
            None
        };
        let has_active_images = items.iter().any(|item| {
            item["entryType"] == "image"
                && matches!(
                    item["status"].as_str(),
                    Some("queued" | "running" | "cancelling")
                )
        });
        if has_active_images
            && let Ok((live, _)) = muse.images.backend.remote_queue(&store.owner).await
        {
            for item in items.iter_mut().filter(|item| item["entryType"] == "image") {
                if let Some(current) = live["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|job| job["id"] == item["id"])
                {
                    item.as_object_mut()
                        .unwrap()
                        .extend(current.as_object().unwrap().clone());
                }
            }
        }
        let batches = items
            .iter()
            .filter(|item| item["entryType"] == "batch")
            .collect::<Vec<_>>();
        Ok(json!({"items":items,"batches":batches,"nextBefore":next}))
    }
    .await;
    http::response(result, StatusCode::OK)
}

pub(super) async fn queue(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
) -> Response {
    if let Some(response) = muse.search_limit.check(false) {
        return response;
    }
    let result = async {
        state.host.check_running()?;
        let store = muse.store()?;
        let (mut live, timings) = muse.images.backend.remote_queue(&store.owner).await?;
        let mut items = store.work(|db, store| {
            let mut statement = db.prepare("SELECT request,family,kind,scene,model,seed,variant,status,job,error,code,batch
                FROM muse_items WHERE owner=?1 AND status='waiting' ORDER BY pos")?;
            let rows = statement.query_map([&store.owner], |row| {
                let key: String = row.get(11)?;
                let mut item = batches::view(row,&key)?;
                item["batchKey"] = json!(key);
                Ok(item)
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        }).await?;
        let ahead = live["gpuAhead"].as_u64().unwrap_or(0);
        let mut seconds = live["estimatedAvailableSeconds"].as_f64();
        for (index, item) in items.iter_mut().enumerate() {
            item["ahead"] = json!(ahead + index as u64);
            item["queuePosition"] = json!(ahead + index as u64 + 1);
            item["estimatedStartSeconds"] = json!(seconds.map(|s| s.ceil() as u64));
            seconds = seconds.zip(item["modelId"].as_str().and_then(|model| timings.get(model))).map(|(start,duration)| start+duration);
            item["estimatedFinishSeconds"] = json!(seconds.map(|s| s.ceil() as u64));
        }
        live["waiting"] = json!(items.len());
        live["items"].as_array_mut().unwrap().append(&mut items);
        Ok(live)
    }.await;
    http::response(result, StatusCode::OK)
}
