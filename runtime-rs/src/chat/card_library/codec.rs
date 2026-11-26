use super::super::{Error, Result, persona::CardData};
use super::is_id;
use crate::catalog::{Catalog, Options};
use axum::{
    body::Bytes,
    extract::Multipart,
    http::{HeaderMap, header::CONTENT_TYPE},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::GenericImageView;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io::Cursor, path::Path as FsPath, time::Duration};

pub(super) const MAX_JSON: usize = 1024 * 1024;
pub(super) const MAX_UPLOAD: usize = 16 * 1024 * 1024;

pub(super) fn storage_error(e: impl std::fmt::Display) -> Error {
    eprintln!("chat card library: {e}");
    Error::stream(
        "CARD_STORAGE_FAILED",
        "角色卡资料库读写失败，请检查本机存储",
    )
}

pub(super) fn database(root: &FsPath) -> Result<Connection> {
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

pub(super) fn not_found() -> Error {
    Error::new(404, "CARD_NOT_FOUND", "本机找不到这张角色卡")
}

pub(super) fn project_catalog(options: Options) -> Result<Option<Catalog>> {
    if !options.database.exists() && !options.database.with_extension("identity.json").exists() {
        return Ok(None);
    }
    Catalog::open_existing(options)
        .map(Some)
        .map_err(storage_error)
}

pub(super) fn normalize_document(mut source: Value) -> Result<(Value, CardData)> {
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

pub(super) fn parse_document(bytes: &[u8]) -> Result<(Value, CardData)> {
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

pub(super) fn encode_avatar_png(bytes: &[u8]) -> Result<Vec<u8>> {
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

pub(super) fn build_summary(id: &str, card: &CardData, source: &str, overridden: bool) -> Value {
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

pub(super) fn unpack_png(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
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

pub(super) fn with_avatar(mut summary: Value, id: &str, exists: bool) -> Value {
    summary["avatarUrl"] = if exists {
        format!("/api/chat/cards/{id}/avatar")
    } else {
        String::new()
    }
    .into();
    summary
}

pub(super) struct CardMutationPayload {
    pub document: Value,
    pub avatar: Option<Vec<u8>>,
    pub remove_avatar: bool,
}

pub(super) async fn parse_mutation_request(
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
