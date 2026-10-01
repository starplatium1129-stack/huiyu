use crate::error::{ApiError, Result};
use axum::http::Method;
use serde_json::{Value, json};
use std::collections::HashMap;

pub(super) type Query = HashMap<String, String>;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

pub(super) fn segments(path: &str) -> Result<Vec<String>> {
    path.trim_start_matches('/')
        .split('/')
        .map(|part| {
            let raw = part.as_bytes();
            let mut decoded = Vec::with_capacity(raw.len());
            let mut i = 0;
            while i < raw.len() {
                if raw[i] == b'%' {
                    let pair = raw
                        .get(i + 1..i + 3)
                        .ok_or_else(|| ApiError::invalid("Invalid path encoding"))?;
                    let hex = std::str::from_utf8(pair)
                        .map_err(|_| ApiError::invalid("Invalid path encoding"))?;
                    decoded.push(
                        u8::from_str_radix(hex, 16)
                            .map_err(|_| ApiError::invalid("Invalid path encoding"))?,
                    );
                    i += 3;
                } else {
                    decoded.push(raw[i]);
                    i += 1;
                }
            }
            String::from_utf8(decoded).map_err(|_| ApiError::invalid("Invalid UTF-8 path"))
        })
        .collect()
}

pub(super) fn text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.contains('\0'))
        .ok_or_else(|| ApiError::invalid("Invalid text field"))
}
fn integer(value: &Value, min: u64) -> Result<Value> {
    value
        .as_u64()
        .filter(|value| *value >= min && *value <= MAX_SAFE)
        .map(Value::from)
        .ok_or_else(|| ApiError::invalid("Invalid integer field"))
}
fn entity_id(value: &Value) -> Result<Value> {
    if !value.is_number() {
        text(value)?;
    }
    Ok(value.clone())
}
fn record(value: &Value) -> Result<Value> {
    if !value.is_object() {
        return Err(ApiError::invalid("Expected an object"));
    }
    Ok(value.clone())
}
fn body(value: &Value) -> Result<Value> {
    entity_id(&value["id"])?;
    record(value)
}
fn array(value: &Value, bounded: bool) -> Result<&Vec<Value>> {
    value
        .as_array()
        .filter(|v| !bounded || (!v.is_empty() && v.len() <= 200))
        .ok_or_else(|| ApiError::invalid("Invalid item list"))
}
fn route_id(id: &str, query: &Query) -> Result<Value> {
    text(&json!(id))?;
    match query.get("idType").map(String::as_str) {
        None | Some("string") => Ok(json!(id)),
        Some("number") if id.trim() == id => {
            let number: f64 = id
                .parse()
                .map_err(|_| ApiError::invalid("Invalid numeric ID"))?;
            if !number.is_finite() {
                return Err(ApiError::invalid("Invalid numeric ID"));
            }
            Ok(json!(number))
        }
        _ => Err(ApiError::invalid("Invalid ID type")),
    }
}
fn media(value: &Value) -> Result<Value> {
    let sha = text(&value["sha256"])?;
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(ApiError::invalid("Invalid media digest"));
    }
    Ok(
        json!({"alias": text(&value["alias"])?, "sha256": sha, "bytes": integer(&value["bytes"], 1)?, "mime": text(&value["mime"])?}),
    )
}
fn chunk(value: &Value) -> Result<Value> {
    let data = value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 1_398_104)
        .ok_or_else(|| ApiError::invalid("Invalid media chunk"))?;
    // Keep the base64 allocation intact across the actor boundary. The storage
    // decoder checks canonical encoding and byte length exactly once.
    Ok(json!(data))
}
fn query_int(query: &Query, key: &str, default: u64, min: u64) -> Result<Value> {
    let value = query
        .get(key)
        .map(|s| s.parse::<u64>())
        .transpose()
        .map_err(|_| ApiError::invalid("Invalid query number"))?
        .unwrap_or(default);
    integer(&json!(value), min)
}

pub(super) fn command(
    method: &Method,
    path: &[String],
    query: &Query,
    input: &Value,
) -> Result<Value> {
    let parts: Vec<&str> = path.iter().map(String::as_str).collect();
    let p = parts.as_slice();
    let verb = if method == Method::HEAD {
        "GET"
    } else {
        method.as_str()
    };
    let operation = || text(&input["operationId"]);
    let revision = || integer(&input["expectedRevision"], 0);
    let route_op = |id: &str| -> Result<Value> {
        text(&json!(id))?;
        Ok(json!(id))
    };
    let result = match (verb, p) {
        ("GET", ["status"]) => json!({"kind": "status"}),
        ("GET", ["media", "count"]) => json!({"kind": "countMedia"}),
        ("GET", ["media", alias, "thumbnail"]) => {
            json!({"kind": "readThumbnail", "alias": route_op(alias)?})
        }
        ("GET", ["media", alias, "chunks"]) => {
            json!({"kind": "readMedia", "alias": route_op(alias)?, "offset": query_int(query, "offset", 0, 0)?, "length": query_int(query, "length", 1_048_576, 1)?.as_u64().unwrap().min(1_048_576)})
        }
        ("POST", ["media-uploads", id]) => {
            json!({"kind": "prepareMedia", "operationId": route_op(id)?, "media": media(&input["media"])?})
        }
        ("POST", ["artwork-saves", id]) => {
            json!({"kind": "prepareSave", "operationId": route_op(id)?, "media": media(&input["media"])?, "artwork": body(&input["artwork"])?})
        }
        (
            "PUT",
            [
                collection @ ("media-uploads" | "artwork-saves"),
                id,
                "chunks",
            ],
        ) => {
            json!({"kind": if *collection == "media-uploads" { "uploadMediaChunk" } else { "uploadChunk" }, "operationId": route_op(id)?, "offset": integer(&input["offset"], 0)?, "data": chunk(&input["data"])?})
        }
        (
            "POST",
            [
                collection @ ("media-uploads" | "artwork-saves"),
                id,
                "commit",
            ],
        ) => {
            json!({"kind": if *collection == "media-uploads" { "commitMedia" } else { "commitSave" }, "operationId": route_op(id)?})
        }
        ("POST", ["artwork-saves", id, "abort"]) => {
            json!({"kind": "abortSave", "operationId": route_op(id)?})
        }
        ("DELETE", ["media", alias]) => {
            json!({"kind": "releaseMedia", "operationId": operation()?, "alias": route_op(alias)?})
        }
        ("POST", ["artworks"]) => {
            json!({"kind": "appendArtwork", "operationId": operation()?, "artwork": body(&input["artwork"])?})
        }
        ("GET", ["artworks"]) => {
            let mut command = json!({"kind": "listArtworks"});
            if let Some(projection) = query.get("projection") {
                command["projection"] = json!(projection);
            }
            if query.contains_key("limit") {
                command["limit"] = query_int(query, "limit", 1, 1)?;
            }
            if let Some(cursor) = query.get("cursor") {
                command["cursor"] = route_op(cursor)?;
            }
            if let Some(deleted) = query.get("includeDeleted") {
                command["includeDeleted"] = json!(deleted == "true");
            }
            command
        }
        ("GET", ["artwork-search-index"]) => json!({"kind": "readArtworkSearchIndex"}),
        ("GET", ["artwork-recent-index"]) => json!({"kind": "readArtworkRecentIndex"}),
        ("GET", ["artworks", id]) => json!({"kind": "getArtwork", "id": route_id(id, query)?}),
        ("POST", ["artworks", "lookup"]) => {
            json!({"kind": "getArtworks", "ids": array(&input["ids"], true)?.iter().map(entity_id).collect::<Result<Vec<_>>>()?})
        }
        ("POST", ["artworks", "trash-batch"]) => {
            let items = array(&input["items"], true)?.iter().map(|item| Ok(json!({"id": entity_id(&item["id"])?, "expectedRevision": integer(&item["expectedRevision"], 0)?}))).collect::<Result<Vec<_>>>()?;
            json!({"kind": "softDeleteArtworks", "operationId": operation()?, "items": items})
        }
        ("POST", ["artworks", "organize"]) => {
            let ids = array(&input["ids"], true)?
                .iter()
                .map(entity_id)
                .collect::<Result<Vec<_>>>()?;
            let revisions = array(&input["expectedRevisions"], true)?.iter().map(|item| Ok(json!({"id":entity_id(&item["id"])?,"revision":integer(&item["revision"],0)?}))).collect::<Result<Vec<_>>>()?;
            let mut command = json!({"kind":"organizeArtworks","operationId":operation()?,"ids":ids,"expectedRevisions":revisions});
            if let Some(project) = input.get("projectId") {
                command["projectId"] = if project.is_null() {
                    Value::Null
                } else {
                    entity_id(project)?
                };
            }
            if let Some(tags) = input.get("collectionTags") {
                command["collectionTags"] = record(tags)?;
            }
            command
        }
        ("POST", ["artworks", "organization-undo"]) => {
            json!({"kind":"undoArtworkOrganization","operationId":operation()?,"sourceOperationId":route_op(text(&input["sourceOperationId"])?)?})
        }
        ("PATCH", ["artworks", id]) => {
            json!({"kind": "patchArtwork", "operationId": operation()?, "id": route_id(id, query)?, "expectedRevision": revision()?, "patch": record(&input["patch"])?})
        }
        ("DELETE", ["artworks", id]) => {
            json!({"kind": "softDeleteArtwork", "operationId": operation()?, "id": route_id(id, query)?, "expectedRevision": revision()?})
        }
        ("DELETE", ["artworks", id, "permanent"]) => {
            json!({"kind": "hardDeleteArtwork", "operationId": operation()?, "id": route_id(id, query)?, "expectedRevision": revision()?})
        }
        ("POST", ["artworks", id, "restore"]) => {
            json!({"kind": "restoreArtwork", "operationId": operation()?, "id": route_id(id, query)?, "expectedRevision": revision()?})
        }
        ("GET", ["projects"]) => json!({"kind": "listProjects"}),
        ("POST", ["projects"]) => {
            json!({"kind": "saveProject", "operationId": operation()?, "project": body(&input["project"])?, "artworkIds": array(&input["artworkIds"], false)?.iter().map(entity_id).collect::<Result<Vec<_>>>()?, "expectedRevision": if input.get("expectedRevision") == Some(&Value::Null) { Value::Null } else { revision()? }})
        }
        ("DELETE", ["projects", id, "smart"]) => {
            json!({"kind":"deleteSmartAlbum","operationId":operation()?,"id":route_id(id,query)?,"expectedRevision":revision()?})
        }
        ("GET", ["operations", id]) => {
            json!({"kind": "getOperation", "operationId": route_op(id)?})
        }
        ("POST", ["trash", "purge"]) => {
            json!({"kind": "purgeExpiredTrash", "operationId": operation()?})
        }
        ("POST", ["trash", "purge-selected"]) => {
            let entries = array(&input["entries"], true)?.iter().map(|entry| Ok(json!({"id":entity_id(&entry["id"])?,"deletedAt":integer(&entry["deletedAt"],0)?}))).collect::<Result<Vec<_>>>()?;
            json!({"kind":"purgeTrash","operationId":operation()?,"entries":entries})
        }
        ("POST", ["media", "collect"]) => {
            json!({"kind": "collectGarbage", "operationId": operation()?})
        }
        ("POST", ["backups"]) => json!({"kind": "backup", "operationId": operation()?}),
        ("POST", ["backups", id, "restore"]) => {
            json!({"kind": "restoreBackup", "operationId": operation()?, "backupId": route_op(id)?})
        }
        ("GET", ["profile", domain @ ("settings" | "chat" | "drafts")]) => {
            let mut command = json!({"kind": match *domain { "settings" => "profile.readSettings", "chat" => "profile.readChat", _ => "profile.readDrafts" }});
            if *domain == "drafts" {
                command["windowId"] =
                    json!(query.get("windowId").map(String::as_str).unwrap_or(""));
            }
            command
        }
        ("PUT", ["profile", domain @ ("settings" | "chat" | "drafts")]) => {
            let mut command = json!({"kind": match *domain { "settings" => "profile.saveSetting", "chat" => "profile.saveChatRecord", _ => "profile.saveDraft" }, "operationId": operation()?, "key": text(&input["key"])?, "value": input.get("value").ok_or_else(|| ApiError::invalid("Missing profile value"))?, "expectedRevision": if input.get("expectedRevision") == Some(&Value::Null) { Value::Null } else { revision()? }});
            if *domain != "settings" {
                command["expectedReset"] = json!(input["expectedReset"].as_str().unwrap_or(""));
            }
            if *domain == "drafts"
                && let Some(window) = input.get("windowId")
            {
                command["windowId"] = json!(text(window)?);
            }
            command
        }
        ("POST", ["profile", "chat", "reset"]) => {
            json!({"kind": "profile.resetChat", "operationId": operation()?, "expectedReset": input["expectedReset"].as_str().unwrap_or("")})
        }
        ("POST", ["migrations"]) => {
            json!({"kind": "migration.begin", "operationId": operation()?, "envelope": record(&input["envelope"])?})
        }
        ("GET", ["migrations", id]) => {
            json!({"kind": "migration.status", "migrationId": route_op(id)?})
        }
        ("POST", ["migrations", id, "verify"]) => {
            json!({"kind": "migration.verify", "operationId": operation()?, "migrationId": route_op(id)?})
        }
        ("POST", ["migrations", id, "records", item]) => {
            json!({"kind": "migration.record", "operationId": operation()?, "migrationId": route_op(id)?, "itemId": route_op(item)?, "record": record(&input["record"])?})
        }
        (
            "PUT",
            [
                "migrations",
                id,
                collection @ ("records" | "media"),
                item,
                "chunks",
            ],
        ) => {
            let mut command = json!({"kind": if *collection == "records" { "migration.recordChunk" } else { "migration.media" }, "operationId": operation()?, "migrationId": route_op(id)?, "offset": integer(&input["offset"], 0)?, "data": chunk(&input["data"])?});
            command[if *collection == "records" {
                "itemId"
            } else {
                "alias"
            }] = route_op(item)?;
            command
        }
        _ => {
            return Err(ApiError::new(
                404,
                "WORKSPACE_ROUTE",
                "Workspace resource does not exist",
            ));
        }
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preference_projection_is_forwarded_as_a_read_only_list() {
        let query = Query::from([("projection".into(), "preference".into())]);
        let result = command(
            &Method::GET,
            &segments("artworks").unwrap(),
            &query,
            &Value::Null,
        )
        .unwrap();
        assert_eq!(
            result,
            json!({"kind":"listArtworks","projection":"preference"})
        );
    }
    #[test]
    fn routes_preserve_numeric_ids_and_do_not_execute_supplied_commands() {
        let query = Query::from([("idType".into(), "number".into())]);
        assert_eq!(
            command(
                &Method::GET,
                &segments("artwork-search-index").unwrap(),
                &query,
                &json!({"kind":"backup"}),
            )
            .unwrap(),
            json!({"kind":"readArtworkSearchIndex"})
        );
        assert_eq!(
            command(
                &Method::GET,
                &segments("artworks/search-index").unwrap(),
                &Query::default(),
                &Value::Null,
            )
            .unwrap(),
            json!({"kind":"getArtwork","id":"search-index"})
        );
        assert_eq!(
            command(
                &Method::GET,
                &segments("artwork-recent-index").unwrap(),
                &query,
                &json!({"kind":"backup"})
            )
            .unwrap(),
            json!({"kind":"readArtworkRecentIndex"})
        );
        assert_eq!(
            command(
                &Method::GET,
                &segments("artworks/recent-index").unwrap(),
                &Query::default(),
                &Value::Null
            )
            .unwrap(),
            json!({"kind":"getArtwork","id":"recent-index"})
        );
        let organized = command(&Method::POST, &segments("artworks/organize").unwrap(), &Query::default(), &json!({"kind":"backup","operationId":"organize-one","ids":[42],"expectedRevisions":[{"id":42,"revision":1}],"projectId":null,"collectionTags":{"add":["keep"]}})).unwrap();
        assert_eq!(organized["kind"], "organizeArtworks");
        assert!(organized["projectId"].is_null());
        assert_eq!(command(&Method::DELETE, &segments("projects/42/smart").unwrap(), &query,
            &json!({"kind":"hardDeleteArtwork","operationId":"delete-smart","expectedRevision":7})).unwrap(),
            json!({"kind":"deleteSmartAlbum","operationId":"delete-smart","id":42.0,"expectedRevision":7}));
        assert_eq!(command(&Method::POST, &segments("artworks/organization-undo").unwrap(), &Query::default(), &json!({"operationId":"undo-one","sourceOperationId":"organize-one","changes":[{"id":"untrusted"}]})).unwrap(),json!({"kind":"undoArtworkOrganization","operationId":"undo-one","sourceOperationId":"organize-one"}));
        let converted = command(
            &Method::GET,
            &segments("artworks/42").unwrap(),
            &query,
            &json!({"kind":"backup"}),
        )
        .unwrap();
        assert_eq!(converted["kind"], "getArtwork");
        assert_eq!(converted["id"].as_f64(), Some(42.0));
        assert_eq!(segments("media/a%2Fb+z/chunks").unwrap()[1], "a/b+z");
    }
}
