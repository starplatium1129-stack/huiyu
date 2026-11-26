use super::super::{Error, Result, local, persona::CardData, running};
use super::codec::{
    database, normalize_document, not_found, parse_document, project_catalog, storage_error,
};
use super::is_id;
use crate::{AppState, catalog::Options};
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use std::{net::SocketAddr, path::Path as FsPath};

pub(super) fn read_card_bundle(
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

#[derive(Deserialize)]
pub(super) struct ExportQuery {
    format: Option<String>,
}

pub(super) async fn export_card(
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

pub(in crate::chat) async fn load_card(app: &AppState, id: &str) -> Result<CardData> {
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
