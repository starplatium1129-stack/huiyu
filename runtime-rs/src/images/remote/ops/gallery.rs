use super::{
    MAX_GALLERY_PAGE_SIZE, OpsLimits, READ_PRINCIPAL, json_response,
    sanitize::{detect_media_type, safe_alias, sanitize_artwork, truthy_flag},
};
use crate::{
    AppState,
    error::{ApiError, Result},
    storage::Storage,
};
use axum::{
    Extension,
    extract::{Path, Query, State},
    response::Response,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};

const MAX_GALLERY_PAGE: usize = 200;
const MAX_GALLERY_SCAN_ITEMS: usize = 5000;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct GalleryListQuery {
    page: Option<usize>,
    page_size: Option<usize>,
    kind: Option<String>,
    media_type: Option<String>,
    character: Option<String>,
    search: Option<String>,
    favorite: Option<String>,
    tag: Option<String>,
    engine: Option<String>,
    model: Option<String>,
    review_state: Option<String>,
}

fn parse_optional_bool(value: Option<&str>) -> Result<Option<bool>> {
    let Some(raw) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Ok(Some(true)),
        "0" | "false" | "no" => Ok(Some(false)),
        _ => Err(ApiError::invalid("favorite 须为 true/false 或 1/0")),
    }
}

fn parse_media_kind(kind: Option<&str>, media_type: Option<&str>) -> Result<Option<&'static str>> {
    let raw = media_type
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| kind.map(str::trim).filter(|s| !s.is_empty()));
    match raw.map(|s| s.to_ascii_lowercase()).as_deref() {
        None | Some("all") => Ok(None),
        Some("image" | "photo" | "picture") => Ok(Some("image")),
        Some("video") => Ok(Some("video")),
        Some("audio") => Ok(Some("audio")),
        _ => Err(ApiError::invalid(
            "kind/mediaType 仅支持 all、image、video 或 audio",
        )),
    }
}

fn validate_short_filter(
    value: Option<&str>,
    max_chars: usize,
    label: &str,
) -> Result<Option<String>> {
    let Some(trimmed) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if trimmed.chars().count() > max_chars || trimmed.chars().any(char::is_control) {
        return Err(ApiError::invalid(format!(
            "{label} 须不超过 {max_chars} 字且不含控制字符"
        )));
    }
    Ok(Some(trimmed.to_owned()))
}

pub(super) fn require_storage(state: &AppState) -> Result<Storage> {
    state
        .host
        .storage()
        .ok_or_else(|| ApiError::new(503, "WORKSPACE_UNAVAILABLE", "桌面作品库尚未启用"))
}

pub(super) async fn gallery_list(
    State(state): State<AppState>,
    Extension(limits): Extension<Arc<OpsLimits>>,
    Query(query): Query<GalleryListQuery>,
) -> Response {
    if let Some(limited) = limits.gallery.check(false) {
        return limited;
    }
    json_response(
        async {
            state.host.check_running()?;
            let storage = require_storage(&state)?;
            let page = query.page.unwrap_or(1);
            let page_size = query.page_size.unwrap_or(20);
            if !(1..=MAX_GALLERY_PAGE).contains(&page) {
                return Err(ApiError::invalid(format!(
                    "page 须在 1 至 {MAX_GALLERY_PAGE} 之间"
                )));
            }
            if !(1..=MAX_GALLERY_PAGE_SIZE).contains(&page_size) {
                return Err(ApiError::invalid(format!(
                    "pageSize 须在 1 至 {MAX_GALLERY_PAGE_SIZE} 之间"
                )));
            }
            let kind_filter =
                parse_media_kind(query.kind.as_deref(), query.media_type.as_deref())?;
            let favorite = parse_optional_bool(query.favorite.as_deref())?;
            let character = validate_short_filter(query.character.as_deref(), 160, "character")?;
            let search = validate_short_filter(query.search.as_deref(), 200, "search")?;
            let tag = validate_short_filter(query.tag.as_deref(), 160, "tag")?;
            let engine = validate_short_filter(query.engine.as_deref(), 80, "engine")?;
            let model = validate_short_filter(query.model.as_deref(), 160, "model")?;
            let review_state =
                validate_short_filter(query.review_state.as_deref(), 40, "reviewState")?;
            if let Some(rs) = review_state.as_deref()
                && !matches!(rs, "candidate" | "preferred" | "rejected")
            {
                return Err(ApiError::invalid(
                    "reviewState 仅支持 candidate、preferred 或 rejected",
                ));
            }

            let mut filter = Map::new();
            if let Some(character) = character {
                filter.insert("characterId".into(), json!(character));
            }
            if let Some(search) = search {
                filter.insert("search".into(), json!(search));
            }
            if let Some(tag) = tag {
                filter.insert("tag".into(), json!(tag));
            }
            if favorite == Some(true) {
                filter.insert("favoriteOnly".into(), json!(true));
            }
            let mut generation = Map::new();
            if let Some(engine) = engine {
                generation.insert("engine".into(), json!(format!("v:{engine}")));
            }
            if let Some(model) = model {
                generation.insert("model".into(), json!(format!("v:{model}")));
            }
            if let Some(rs) = review_state {
                generation.insert("reviewState".into(), json!(format!("v:{rs}")));
            }
            if !generation.is_empty() {
                filter.insert("generation".into(), Value::Object(generation));
            }
            let filter_value = Value::Object(filter);

            let offset = (page - 1) * page_size;
            let need_end = offset + page_size;
            let post_filtered = kind_filter.is_some() || favorite == Some(false);

            let mut cursor: Option<Value> = None;
            let mut matched = 0usize;
            let mut scanned = 0usize;
            let mut collected = Vec::with_capacity(page_size);
            let mut has_more = false;
            let mut total_unfiltered;
            let mut revision;

            loop {
                let batch_limit = if !post_filtered {
                    let remaining = (need_end + 1).saturating_sub(matched);
                    remaining.clamp(1, 200)
                } else {
                    200
                };
                let mut cmd = json!({
                    "kind": "readGalleryPage",
                    "query": filter_value,
                    "limit": batch_limit as i64
                });
                if let Some(c) = cursor.take() {
                    cmd["cursor"] = c;
                }
                let result = storage.request(cmd, READ_PRINCIPAL).await?;
                total_unfiltered = result["total"].as_i64().unwrap_or(0);
                revision = result["revision"].as_i64().unwrap_or(0);
                let items = result["items"].as_array().cloned().unwrap_or_default();
                let next_cursor = result.get("nextCursor").filter(|v| !v.is_null()).cloned();

                for record in items {
                    scanned += 1;
                    let body = &record["body"];
                    if let Some(expected_kind) = kind_filter
                        && detect_media_type(body, None) != expected_kind
                    {
                        continue;
                    }
                    if favorite == Some(false) && truthy_flag(&body["favorite"]) {
                        continue;
                    }
                    if matched >= offset && collected.len() < page_size {
                        collected.push(sanitize_artwork(&record, false, None));
                    } else if matched >= need_end {
                        has_more = true;
                        break;
                    }
                    matched += 1;
                }

                if has_more || next_cursor.is_none() || scanned >= MAX_GALLERY_SCAN_ITEMS {
                    if !has_more && next_cursor.is_some() && collected.len() == page_size {
                        has_more = true;
                    }
                    break;
                }
                cursor = next_cursor;
            }

            let total = if post_filtered {
                Value::Null
            } else {
                json!(total_unfiltered)
            };

            Ok(json!({
                "page": page,
                "pageSize": page_size,
                "total": total,
                "hasMore": has_more,
                "revision": revision,
                "items": collected
            }))
        }
        .await,
    )
}

fn validate_artwork_id_segment(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 256
        || id.contains(['\0', '/', '\\'])
        || id.contains("..")
    {
        return Err(ApiError::invalid("作品编号无效"));
    }
    Ok(())
}

pub(super) async fn lookup_artwork(
    storage: &Storage,
    id: &str,
    id_type: Option<&str>,
) -> Result<Value> {
    validate_artwork_id_segment(id)?;
    let parse_num = |raw: &str| -> Option<Value> {
        if raw.trim() != raw {
            return None;
        }
        let n: f64 = raw.parse().ok()?;
        if !n.is_finite() {
            return None;
        }
        Some(json!(n))
    };
    let record = match id_type {
        Some("number") => {
            let num = parse_num(id).ok_or_else(|| ApiError::invalid("数字类型作品编号无效"))?;
            storage
                .request(json!({"kind": "getArtwork", "id": num}), READ_PRINCIPAL)
                .await?
        }
        Some("string") => {
            storage
                .request(json!({"kind": "getArtwork", "id": id}), READ_PRINCIPAL)
                .await?
        }
        None => {
            let by_str = storage
                .request(json!({"kind": "getArtwork", "id": id}), READ_PRINCIPAL)
                .await?;
            if !by_str.is_null() {
                by_str
            } else if let Some(num) = parse_num(id) {
                storage
                    .request(json!({"kind": "getArtwork", "id": num}), READ_PRINCIPAL)
                    .await?
            } else {
                Value::Null
            }
        }
        _ => return Err(ApiError::invalid("idType 仅支持 string 或 number")),
    };
    if record.is_null() || !record["deletedAt"].is_null() {
        return Err(ApiError::new(
            404,
            "GALLERY_ITEM_NOT_FOUND",
            "作品不存在或已移入回收站",
        ));
    }
    Ok(record)
}

pub(super) async fn gallery_item(
    State(state): State<AppState>,
    Extension(limits): Extension<Arc<OpsLimits>>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Some(limited) = limits.gallery.check(false) {
        return limited;
    }
    json_response(
        async {
            state.host.check_running()?;
            let storage = require_storage(&state)?;
            let id_type = query.get("idType").map(String::as_str);
            let record = lookup_artwork(&storage, &id, id_type).await?;
            let media = if let Some(alias) = safe_alias(&record["body"]) {
                tokio::time::timeout(Duration::from_secs(10), storage.media(alias))
                    .await
                    .ok()
                    .and_then(|res| res.ok())
            } else {
                None
            };
            let media_info = media
                .as_ref()
                .map(|m| (m.mime.as_str(), m.total_bytes, m.sha256.as_str()));
            let item = sanitize_artwork(&record, true, media_info);
            Ok(json!({"item": item}))
        }
        .await,
    )
}
