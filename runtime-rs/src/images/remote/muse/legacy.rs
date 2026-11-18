//! Single catalog draws used the caller's key directly as a family receipt.
//! Those receipts survive upgrades and must never be dispatched a second time.
use super::*;
use crate::generation::receipts::Receipt;

pub(super) async fn find(muse: &Muse, key: &str) -> Result<Option<Receipt>> {
    let owner = &muse.store()?.owner;
    let mut found = None;
    for family in ["anima", "moss-image"] {
        if let Some(receipt) = muse.images.requests.status(key, owner, family).await? {
            if found.is_some() {
                return Err(ApiError::new(
                    409,
                    "MUSE_KEY_AMBIGUOUS",
                    "旧请求在两个模型中用了同一编号，请使用原回执的 statusPath",
                ));
            }
            found = Some(receipt);
        }
    }
    Ok(found)
}

pub(super) fn matches(receipt: &Receipt, scenes: &mut [PreparedScene]) -> bool {
    let [scene] = scenes else { return false };
    if scene.family != receipt.family || scene.variants != 1 || scene.kind == "prompt" {
        return false;
    }
    // The old single-draw route only inserted the seed when the caller supplied it.
    if let Some(seed) = scene.seed {
        scene.payload["seed"] = json!(seed);
    }
    crate::storage::json_fingerprint(&scene.payload) == receipt.fingerprint
}

pub(super) async fn view(muse: &Muse, receipt: Receipt) -> Result<Value> {
    let key = receipt.request_key.clone();
    let family = receipt.family.clone();
    let route = generation::remote_images::image_route(&family).unwrap();
    let direct = format!("/api/{route}/requests/{key}");
    let mut response = muse.images.receipt_value(receipt).await?;
    let job = &response["job"];
    let rejection = &response["rejected"];
    let status = job["status"].as_str().unwrap_or_else(|| {
        if rejection["code"] == "IMAGE_REQUEST_CANCELLED" {
            "cancelled"
        } else if rejection.is_object() {
            "failed"
        } else {
            "waiting"
        }
    });
    let mut item = json!({"requestKey":key,"batchKey":key,"family":family,"variant":1,
        "jobId":job["id"],"status":status,"statusPath":direct,"cancelPath":direct});
    for field in [
        "modelId",
        "seed",
        "progress",
        "progressText",
        "resultAvailable",
        "resultUrl",
        "resultBytes",
        "resultSha256",
        "generationMs",
        "finishedAt",
        "code",
        "error",
    ] {
        item[field] = job[field].clone();
    }
    if rejection.is_object() {
        item["code"] = rejection["code"].clone();
        item["error"] = rejection["message"].clone();
    }
    response["createdAt"] = job["createdAt"].clone();
    response["batchKey"] = json!(key);
    response["statusPath"] = json!(format!("/api/muse/batches/{key}"));
    response["cancelPath"] = json!(direct);
    response["items"] = json!([item]);
    Ok(response)
}
