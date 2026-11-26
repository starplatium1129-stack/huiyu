mod codec;
mod export;

use super::{Error, Result, local, request_body, running};
use crate::{AppState, catalog::Options};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use codec::{
    MAX_JSON, MAX_UPLOAD, build_summary, database, normalize_document, not_found, parse_document,
    parse_mutation_request, project_catalog, storage_error, unpack_png, with_avatar,
};
use export::{export_card, read_card_bundle};
pub(super) use export::load_card;
pub(crate) use codec::validate_catalog_card;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, net::SocketAddr, path::Path as FsPath, time::Duration};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/chat/cards",
            get(list)
                .post(import)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD + 65536)),
        )
        .route(
            "/api/chat/cards/create",
            post(create).layer(DefaultBodyLimit::max(MAX_UPLOAD + 65536)),
        )
        .route(
            "/api/chat/cards/{id}",
            get(detail)
                .put(update)
                .delete(remove)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD + 65536)),
        )
        .route("/api/chat/cards/{id}/avatar", get(avatar))
        .route("/api/chat/cards/{id}/export", get(export_card))
}

pub(super) fn is_id(id: &str) -> bool {
    id.strip_prefix("card-").is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn import_card(root: &FsPath, bytes: &[u8]) -> Result<Value> {
    let (payload, avatar) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let (payload, avatar) = unpack_png(bytes)?;
        (std::borrow::Cow::Owned(payload), Some(avatar))
    } else {
        (std::borrow::Cow::Borrowed(bytes), None)
    };
    let (mut document, card) = parse_document(&payload)?;
    // Whitespace, object field order, containers and filenames do not split a conversation.
    document.sort_all_objects();
    let source = serde_json::to_vec(&document).map_err(storage_error)?;
    let id = format!("card-{:x}", Sha256::digest(&source));
    let summary = build_summary(&id, &card, "user", false);
    let db = database(root)?;
    let has_avatar: bool = db
        .query_row(
            "INSERT INTO cards(id, document, summary, avatar) VALUES (?1,?2,?3,?4)
        ON CONFLICT(id) DO UPDATE SET avatar = coalesce(excluded.avatar, cards.avatar)
        RETURNING avatar IS NOT NULL",
            params![id, source, summary.to_string(), avatar],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    Ok(with_avatar(summary, &id, has_avatar))
}

async fn import(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut form: Multipart,
) -> Result<Json<Value>> {
    local(&headers, peer)?;
    running(&app)?;
    let slot = request_body::admit(&app.shutdown).await?;
    let receive = async {
        let err = |e: axum::extract::multipart::MultipartError| {
            Error::new(
                e.status().as_u16(),
                "CARD_UPLOAD_FAILED",
                "文件过大或角色卡表单无效",
            )
        };
        let field = form
            .next_field()
            .await
            .map_err(err)?
            .ok_or_else(|| Error::invalid("请选择一张角色卡"))?;
        if field.name() != Some("file") {
            return Err(Error::invalid("请选择角色卡文件"));
        }
        let bytes = field.bytes().await.map_err(err)?;
        if bytes.len() > MAX_UPLOAD {
            return Err(Error::invalid("角色卡文件最大 16 MiB"));
        }
        if form.next_field().await.map_err(err)?.is_some() {
            return Err(Error::invalid("每次导入一张角色卡"));
        }
        Ok(bytes)
    };
    let bytes = tokio::time::timeout(Duration::from_secs(60), receive)
        .await
        .map_err(|_| Error::new(408, "CARD_UPLOAD_TIMEOUT", "角色卡上传超时"))??;
    let worker = request_body::acquire(&app.shutdown).await?;
    let root = app.config.runtime_root.clone();
    let card = tokio::task::spawn_blocking(move || {
        let _permits = (slot, worker);
        import_card(&root, &bytes)
    })
    .await
    .map_err(storage_error)??;
    Ok(Json(json!({"card":card})))
}

#[derive(Deserialize)]
struct CardFilter { id: Option<String> }

async fn list(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(filter): Query<CardFilter>,
) -> Result<Response> {
    local(&headers, peer)?;
    running(&app)?;
    if filter.id.as_deref().is_some_and(|id| !is_id(id)) { return Err(not_found()); }
    let root = app.config.runtime_root.clone();
    let catalog = Options::from_config(&app.config);
    let cards = tokio::task::spawn_blocking(move || -> Result<Vec<Value>> {
        let mut cards = match project_catalog(catalog)? {
            Some(catalog) => catalog.chat_cards(filter.id.as_deref()).map_err(storage_error)?,
            None => Vec::new(),
        };
        for card in &mut cards {
            card["source"] = json!("catalog");
            card["overridden"] = json!(false);
        }
        if !root.join("state/chat-cards.sqlite").try_exists().map_err(storage_error)? {
            return Ok(cards);
        }
        let project_indices: HashMap<String, usize> = cards
            .iter()
            .enumerate()
            .filter_map(|(i, card)| Some((card["id"].as_str()?.to_owned(), i)))
            .collect();
        let db = database(&root)?;
        let mut query = db
            .prepare("SELECT id, summary, avatar IS NOT NULL, document FROM cards WHERE (?1 IS NULL OR id = ?1) ORDER BY rowid")
            .map_err(storage_error)?;
        let rows = query
            .query_map(params![filter.id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(storage_error)?;
        for row in rows {
            let (id, summary, exists, document) = row.map_err(storage_error)?;
            let is_catalog = project_indices.contains_key(&id);
            let parsed_summary = if let Ok((_, card)) = parse_document(&document) {
                build_summary(&id, &card, if is_catalog { "catalog" } else { "user" }, is_catalog)
            } else {
                let mut fallback: Value = serde_json::from_str(&summary).map_err(storage_error)?;
                fallback["source"] = json!(if is_catalog { "catalog" } else { "user" });
                fallback["overridden"] = json!(is_catalog);
                fallback
            };
            let entry = with_avatar(parsed_summary, &id, exists);
            if let Some(&index) = project_indices.get(&id) {
                cards[index] = entry;
            } else {
                cards.push(entry);
            }
        }
        Ok(cards)
    })
    .await
    .map_err(storage_error)??;
    Ok((
        [("cache-control", "no-store")],
        Json(json!({"cards":cards})),
    )
        .into_response())
}

async fn avatar(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    local(&headers, peer)?;
    running(&app)?;
    if !is_id(&id) {
        return Err(not_found());
    }
    let root = app.config.runtime_root.clone();
    let image = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        database(&root)?
            .query_row(
                "SELECT avatar FROM cards WHERE id=? AND avatar IS NOT NULL",
                [&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(not_found)
    })
    .await
    .map_err(storage_error)??;
    Ok((
        [
            ("content-type", "image/png"),
            ("cache-control", "private, no-cache"),
        ],
        image,
    )
        .into_response())
}

async fn detail(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    local(&headers, peer)?;
    running(&app)?;
    if !is_id(&id) {
        return Err(not_found());
    }
    let root = app.config.runtime_root.clone();
    let catalog = Options::from_config(&app.config);
    let id_clone = id.clone();
    let body = tokio::task::spawn_blocking(move || -> Result<Value> {
        let (doc_bytes, card, avatar, source, overridden) =
            read_card_bundle(&root, catalog, &id_clone)?;
        let (document, _) = normalize_document(
            serde_json::from_slice(&doc_bytes).map_err(storage_error)?,
        )?;
        let summary = with_avatar(
            build_summary(&id_clone, &card, source, overridden),
            &id_clone,
            avatar.is_some(),
        );
        Ok(json!({
            "ok": true,
            "id": id_clone,
            "source": source,
            "overridden": overridden,
            "summary": summary,
            "document": document,
        }))
    })
    .await
    .map_err(storage_error)??;
    Ok(([("cache-control", "no-store")], Json(body)).into_response())
}

async fn create(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: axum::extract::Request,
) -> Result<Json<Value>> {
    local(&headers, peer)?;
    running(&app)?;
    let _slot = request_body::admit(&app.shutdown).await?;
    let payload = tokio::time::timeout(
        Duration::from_secs(60),
        parse_mutation_request(&headers, request),
    )
    .await
    .map_err(|_| Error::new(408, "CARD_UPLOAD_TIMEOUT", "角色卡提交超时"))??;
    let _worker = request_body::acquire(&app.shutdown).await?;
    let root = app.config.runtime_root.clone();
    let card = tokio::task::spawn_blocking(move || -> Result<Value> {
        let (document, card) = normalize_document(payload.document)?;
        let source = serde_json::to_vec(&document).map_err(storage_error)?;
        if source.len() > MAX_JSON {
            return Err(Error::invalid("角色卡 JSON 超过 1 MiB"));
        }
        let mut hasher = Sha256::new();
        hasher.update(&source);
        hasher.update(uuid::Uuid::new_v4().as_bytes());
        let id = format!("card-{:x}", hasher.finalize());
        let summary = build_summary(&id, &card, "user", false);
        let has_avatar = payload.avatar.is_some();
        database(&root)?
            .execute(
                "INSERT INTO cards(id, document, summary, avatar) VALUES (?1,?2,?3,?4)",
                params![id, source, summary.to_string(), payload.avatar],
            )
            .map_err(storage_error)?;
        Ok(with_avatar(summary, &id, has_avatar))
    })
    .await
    .map_err(storage_error)??;
    Ok(Json(json!({ "ok": true, "card": card })))
}

async fn update(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> Result<Json<Value>> {
    local(&headers, peer)?;
    running(&app)?;
    if !is_id(&id) {
        return Err(not_found());
    }
    let _slot = request_body::admit(&app.shutdown).await?;
    let payload = tokio::time::timeout(
        Duration::from_secs(60),
        parse_mutation_request(&headers, request),
    )
    .await
    .map_err(|_| Error::new(408, "CARD_UPLOAD_TIMEOUT", "角色卡保存超时"))??;
    let _worker = request_body::acquire(&app.shutdown).await?;
    let root = app.config.runtime_root.clone();
    let catalog = Options::from_config(&app.config);
    let card = tokio::task::spawn_blocking(move || -> Result<Value> {
        let (_, _, old_avatar, source_kind, _) = read_card_bundle(&root, catalog, &id)?;
        let is_catalog = source_kind == "catalog";
        let (document, card) = normalize_document(payload.document)?;
        let doc_bytes = serde_json::to_vec(&document).map_err(storage_error)?;
        if doc_bytes.len() > MAX_JSON {
            return Err(Error::invalid("角色卡 JSON 超过 1 MiB"));
        }
        let next_avatar = if payload.remove_avatar {
            None
        } else {
            payload.avatar.or(old_avatar)
        };
        let summary = build_summary(&id, &card, source_kind, is_catalog);
        let has_avatar = next_avatar.is_some();
        database(&root)?
            .execute(
                "INSERT INTO cards(id, document, summary, avatar) VALUES (?1,?2,?3,?4)
                ON CONFLICT(id) DO UPDATE SET document = excluded.document, summary = excluded.summary, avatar = excluded.avatar",
                params![id, doc_bytes, summary.to_string(), next_avatar],
            )
            .map_err(storage_error)?;
        Ok(with_avatar(summary, &id, has_avatar))
    })
    .await
    .map_err(storage_error)??;
    Ok(Json(json!({ "ok": true, "card": card })))
}

async fn remove(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    local(&headers, peer)?;
    running(&app)?;
    if !is_id(&id) {
        return Err(not_found());
    }
    let root = app.config.runtime_root.clone();
    let catalog = Options::from_config(&app.config);
    let restored_catalog = tokio::task::spawn_blocking(move || -> Result<bool> {
        let in_catalog = project_catalog(catalog)?
            .map(|cat| cat.chat_card_document(&id))
            .transpose()
            .map_err(storage_error)?
            .flatten()
            .is_some();
        let affected = if root.join("state/chat-cards.sqlite").try_exists().map_err(storage_error)? {
            database(&root)?
                .execute("DELETE FROM cards WHERE id=?", [&id])
                .map_err(storage_error)?
        } else {
            0
        };
        if affected == 0 && !in_catalog {
            return Err(not_found());
        }
        Ok(in_catalog)
    })
    .await
    .map_err(storage_error)??;
    Ok(Json(json!({ "ok": true, "restoredCatalog": restored_catalog })))
}
