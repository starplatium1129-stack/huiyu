use super::{Error, Result, local, persona::CardData, request_body, running};
use crate::{
    AppState,
    catalog::{Catalog, Options},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderMap, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::GenericImageView;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap, io::Cursor, net::SocketAddr, path::Path as FsPath, time::Duration,
};

const MAX_JSON: usize = 1024 * 1024;
const MAX_UPLOAD: usize = 16 * 1024 * 1024;

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

fn storage_error(e: impl std::fmt::Display) -> Error {
    eprintln!("chat card library: {e}");
    Error::stream(
        "CARD_STORAGE_FAILED",
        "角色卡资料库读写失败，请检查本机存储",
    )
}

fn database(root: &FsPath) -> Result<Connection> {
    let directory = root.join("state");
    std::fs::create_dir_all(&directory).map_err(storage_error)?;
    let db = Connection::open(directory.join("chat-cards.sqlite")).map_err(storage_error)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(storage_error)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, document BLOB NOT NULL, summary TEXT NOT NULL, avatar BLOB
    )",
    )
    .map_err(storage_error)?;
    Ok(db)
}

fn not_found() -> Error {
    Error::new(404, "CARD_NOT_FOUND", "本机找不到这张角色卡")
}

fn project_catalog(options: Options) -> Result<Option<Catalog>> {
    if !options.database.exists() && !options.database.with_extension("identity.json").exists() {
        return Ok(None);
    }
    Catalog::open_existing(options)
        .map(Some)
        .map_err(storage_error)
}

fn normalize_document(mut source: Value) -> Result<(Value, CardData)> {
    let mut normalized = match source.get("spec").and_then(Value::as_str) {
        Some("chara_card_v2" | "chara_card_v3") => {
            if !source["data"].is_object() {
                return Err(Error::invalid("角色卡 data 字段必须是对象"));
            }
            source
        }
        None if source.get("name").is_some() => {
            let data = std::mem::take(&mut source);
            json!({
                "spec": "chara_card_v2",
                "spec_version": "2.0",
                "data": data,
            })
        }
        _ => return Err(Error::invalid("请选择酒馆 V1、V2 或 V3 角色卡")),
    };
    let card = CardData::deserialize(&normalized["data"])
        .map_err(|_| Error::invalid("角色卡的字段格式错误"))?;
    card.validate_import()?;
    normalized.sort_all_objects();
    Ok((normalized, card))
}

fn parse_document(bytes: &[u8]) -> Result<(Value, CardData)> {
    if bytes.len() > MAX_JSON {
        return Err(Error::invalid("角色卡 JSON 超过 1 MiB"));
    }
    let source: Value =
        serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes))
            .map_err(|_| Error::invalid("角色卡不是有效的 UTF-8 JSON"))?;
    let data = match source.get("spec") {
        Some(spec) if spec == "chara_card_v2" || spec == "chara_card_v3" => &source["data"],
        None if source.get("name").is_some()
            && [
                "description",
                "first_mes",
                "personality",
                "scenario",
                "mes_example",
            ]
            .iter()
            .any(|key| source.get(key).is_some()) =>
        {
            &source
        }
        _ => return Err(Error::invalid("请选择酒馆 V1、V2 或 V3 角色卡")),
    };
    let card = CardData::deserialize(data).map_err(|_| Error::invalid("角色卡的字段格式错误"))?;
    card.validate_import()?;
    Ok((source, card))
}

fn encode_avatar_png(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() > MAX_UPLOAD {
        return Err(Error::invalid("头像文件最大 16 MiB"));
    }
    let picture = image::load_from_memory(bytes)
        .map_err(|_| Error::invalid("头像无法解码，请上传 PNG、JPEG、GIF 或 WebP 图片"))?;
    let (width, height) = picture.dimensions();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16_777_216
    {
        return Err(Error::invalid("角色头像最多 1600 万像素，单边不超过 8192"));
    }
    let mut avatar = Cursor::new(Vec::new());
    picture
        .thumbnail(512, 512)
        .write_to(&mut avatar, image::ImageFormat::Png)
        .map_err(|_| Error::invalid("头像转换 PNG 失败"))?;
    Ok(avatar.into_inner())
}

fn build_summary(id: &str, card: &CardData, source: &str, overridden: bool) -> Value {
    let mut summary = json!({
        "id": id,
        "name": card.name.trim(),
        "description": card.description.chars().take(160).collect::<String>(),
        "greeting": card.greeting(),
        "greetings": card.greetings(),
        "source": source,
        "overridden": overridden,
        "loreCount": card.lore_count(),
    });
    if let Some(catalog_id) = card.catalog_id() {
        summary["catalogId"] = json!(catalog_id);
    }
    if let Some(voice_id) = card.voice_id() {
        summary["voiceId"] = json!(voice_id);
    }
    summary
}

pub(crate) fn validate_catalog_card(entry: &Value, character_id: &str) -> crate::error::Result<()> {
    use crate::error::ApiError;
    if !entry["id"].as_str().is_some_and(is_id) {
        return Err(ApiError::invalid("聊天卡需要稳定的卡片 ID"));
    }
    let document = &entry["document"];
    let (_, card) =
        parse_document(&serde_json::to_vec(document)?).map_err(|e| ApiError::invalid(e.message))?;
    if card.catalog_id() != Some(character_id)
        || [
            "name",
            "description",
            "personality",
            "scenario",
            "first_mes",
            "mes_example",
        ]
        .iter()
        .any(|field| {
            document["data"][field]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
        })
    {
        return Err(ApiError::invalid(
            "项目聊天卡须关联当前角色并填写人设、场景、开场白和示例对话",
        ));
    }
    Ok(())
}

fn unpack_png(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let invalid = |_| Error::invalid("PNG 头像损坏或超出尺寸限制");
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(bytes),
        png::Limits {
            bytes: 32 * 1024 * 1024,
        },
    );
    decoder.set_ignore_iccp_chunk(true);
    let mut reader = decoder.read_info().map_err(invalid)?;
    let (width, height) = reader.info().size();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16_777_216
    {
        return Err(Error::invalid("角色头像最多 1600 万像素，单边不超过 8192"));
    }
    reader.finish().map_err(invalid)?;
    let chunks = &reader.info().uncompressed_latin1_text;
    let meta = ["ccv3", "chara"]
        .into_iter()
        .find_map(|tag| chunks.iter().find(|c| c.keyword == tag))
        .ok_or_else(|| Error::invalid("这张 PNG 是普通图片，未内嵌酒馆角色卡"))?;
    if meta.text.len() > MAX_JSON.div_ceil(3) * 4 {
        return Err(Error::invalid("内嵌角色卡超过 1 MiB"));
    }
    let document = STANDARD
        .decode(meta.text.trim())
        .map_err(|_| Error::invalid("PNG 内嵌角色卡编码错误"))?;
    drop(reader);

    // Re-encode only the visible image. The avatar URL must not leak the embedded prompts or ancillary data.
    let picture = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|_| Error::invalid("PNG 头像无法解码"))?;
    let mut avatar = Cursor::new(Vec::new());
    picture
        .thumbnail(512, 512)
        .write_to(&mut avatar, image::ImageFormat::Png)
        .map_err(|_| Error::invalid("PNG 头像无法读取"))?;
    Ok((document, avatar.into_inner()))
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

fn with_avatar(mut summary: Value, id: &str, exists: bool) -> Value {
    summary["avatarUrl"] = if exists {
        format!("/api/chat/cards/{id}/avatar")
    } else {
        String::new()
    }
    .into();
    summary
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

struct CardMutationPayload {
    document: Value,
    avatar: Option<Vec<u8>>,
    remove_avatar: bool,
}

async fn parse_mutation_request(
    headers: &HeaderMap,
    request: axum::extract::Request,
) -> Result<CardMutationPayload> {
    let is_multipart = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.to_ascii_lowercase().starts_with("multipart/form-data"));
    if is_multipart {
        use axum::extract::FromRequest;
        let mut form = Multipart::from_request(request, &())
            .await
            .map_err(|_| Error::invalid("表单格式错误或请求过大"))?;
        let mut raw_card: Option<Vec<u8>> = None;
        let mut raw_avatar: Option<Vec<u8>> = None;
        let mut remove_avatar = false;
        while let Some(field) = form
            .next_field()
            .await
            .map_err(|_| Error::invalid("上传字段无效或超出大小限制"))?
        {
            match field.name() {
                Some("card" | "document") => {
                    let bytes = field.bytes().await.map_err(|_| Error::invalid("角色卡数据读取失败"))?;
                    if bytes.len() > MAX_JSON {
                        return Err(Error::invalid("角色卡 JSON 超过 1 MiB"));
                    }
                    raw_card = Some(bytes.to_vec());
                }
                Some("avatar" | "file") => {
                    let bytes = field.bytes().await.map_err(|_| Error::invalid("头像读取失败"))?;
                    if !bytes.is_empty() {
                        if bytes.len() > MAX_UPLOAD {
                            return Err(Error::invalid("头像文件最大 16 MiB"));
                        }
                        raw_avatar = Some(bytes.to_vec());
                    }
                }
                Some("removeAvatar") => {
                    let text = field.text().await.unwrap_or_default();
                    remove_avatar = text.trim() == "true";
                }
                _ => {}
            }
        }
        let card_bytes = raw_card.ok_or_else(|| Error::invalid("缺少角色卡内容"))?;
        let document: Value = serde_json::from_slice(&card_bytes)
            .map_err(|_| Error::invalid("角色卡 JSON 格式无效"))?;
        let avatar = raw_avatar
            .map(|bytes| encode_avatar_png(&bytes))
            .transpose()?;
        return Ok(CardMutationPayload {
            document,
            avatar,
            remove_avatar,
        });
    }
    use axum::extract::FromRequest;
    let bytes = Bytes::from_request(request, &())
        .await
        .map_err(|_| Error::invalid("请求体过大或无法读取"))?;
    if bytes.len() > MAX_JSON + 65536 {
        return Err(Error::invalid("请求 JSON 过大"));
    }
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|_| Error::invalid("请求 JSON 格式无效"))?;
    let remove_avatar = payload.get("removeAvatar").and_then(Value::as_bool) == Some(true);
    let document = if payload.get("document").is_some_and(Value::is_object) {
        payload["document"].clone()
    } else {
        payload
    };
    Ok(CardMutationPayload {
        document,
        avatar: None,
        remove_avatar,
    })
}

fn read_card_bundle(
    root: &FsPath,
    catalog: Options,
    id: &str,
) -> Result<(Vec<u8>, CardData, Option<Vec<u8>>, &'static str, bool)> {
    let catalog_opt = project_catalog(catalog)?;
    let in_catalog = catalog_opt
        .as_ref()
        .map(|cat| cat.chat_card_document(id))
        .transpose()
        .map_err(storage_error)?
        .flatten();

    if root.join("state/chat-cards.sqlite").try_exists().map_err(storage_error)? {
        if let Some((doc, avatar)) = database(root)?
            .query_row(
                "SELECT document, avatar FROM cards WHERE id=?",
                [id],
                |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Option<Vec<u8>>>(1)?)),
            )
            .optional()
            .map_err(storage_error)?
        {
            let (_, card) = parse_document(&doc)?;
            let is_catalog = in_catalog.is_some();
            return Ok((
                doc,
                card,
                avatar,
                if is_catalog { "catalog" } else { "user" },
                is_catalog,
            ));
        }
    }

    if let Some(catalog_doc) = in_catalog {
        let bytes = catalog_doc.into_bytes();
        let (_, card) = parse_document(&bytes)?;
        return Ok((bytes, card, None, "catalog", false));
    }

    Err(not_found())
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

#[derive(Deserialize)]
struct ExportQuery {
    format: Option<String>,
}

async fn export_card(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<ExportQuery>,
) -> Result<Response> {
    local(&headers, peer)?;
    running(&app)?;
    if !is_id(&id) {
        return Err(not_found());
    }
    let format = query.format.unwrap_or_else(|| "json".into());
    if format != "json" && format != "png" {
        return Err(Error::invalid("导出格式必须是 json 或 png"));
    }
    let root = app.config.runtime_root.clone();
    let catalog = Options::from_config(&app.config);
    let id_clone = id.clone();
    let (content_type, disposition, bytes) =
        tokio::task::spawn_blocking(move || -> Result<(&'static str, String, Vec<u8>)> {
            let (doc_bytes, _, avatar, _, _) = read_card_bundle(&root, catalog, &id_clone)?;
            let (document, _) = normalize_document(
                serde_json::from_slice(&doc_bytes).map_err(storage_error)?,
            )?;
            let short = &id_clone[5..17];
            if format == "json" {
                let pretty = serde_json::to_vec_pretty(&document).map_err(storage_error)?;
                return Ok((
                    "application/json; charset=utf-8",
                    format!("attachment; filename=\"card-{short}.json\""),
                    pretty,
                ));
            }
            let compact = serde_json::to_vec(&document).map_err(storage_error)?;
            let rgba = if let Some(avatar_bytes) = avatar {
                image::load_from_memory(&avatar_bytes)
                    .map_err(storage_error)?
                    .into_rgba8()
            } else {
                image::RgbaImage::from_pixel(512, 768, image::Rgba([244, 239, 230, 255]))
            };
            let (width, height) = rgba.dimensions();
            let mut png_bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder
                    .add_text_chunk("chara".to_string(), STANDARD.encode(&compact))
                    .map_err(storage_error)?;
                let mut writer = encoder.write_header().map_err(storage_error)?;
                writer
                    .write_image_data(rgba.as_raw())
                    .map_err(storage_error)?;
            }
            Ok((
                "image/png",
                format!("attachment; filename=\"card-{short}.png\""),
                png_bytes,
            ))
        })
        .await
        .map_err(storage_error)??;
    Ok((
        [
            ("content-type", content_type.to_owned()),
            ("content-disposition", disposition),
            ("cache-control", "no-store".to_owned()),
        ],
        bytes,
    )
        .into_response())
}

pub(super) async fn load_card(app: &AppState, id: &str) -> Result<CardData> {
    let root = app.config.runtime_root.clone();
    let catalog = Options::from_config(&app.config);
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || {
        if root.join("state/chat-cards.sqlite").try_exists().map_err(storage_error)?
            && let Some(source) = database(&root)?
                .query_row("SELECT document FROM cards WHERE id=?", [&id], |r| r.get::<_, Vec<u8>>(0))
                .optional()
                .map_err(storage_error)?
        {
            return parse_document(&source).map(|(_, card)| card);
        }
        if let Some(catalog) = project_catalog(catalog)?
            && let Some(document) = catalog.chat_card_document(&id).map_err(storage_error)?
        {
            return parse_document(document.as_bytes()).map(|(_, card)| card);
        }
        Err(not_found())
    })
    .await
    .map_err(storage_error)?
}
