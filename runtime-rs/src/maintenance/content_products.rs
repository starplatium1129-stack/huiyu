#[cfg(test)]
mod tests;
use super::{
    Error, Options, Result, blueprints, codec, fs, prompt, save as transaction_save, showcase,
    state, transaction::Transaction,
};
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use serde_json::{Value, json};
use std::{path::Path, time::Instant};
use tokio_util::sync::CancellationToken;

/// Client-side rendering already produced both JPEGs. Preserve those exact
/// bytes; this route never re-encodes the image or changes generation metadata.
fn jpeg(value: &Value, label: &str) -> Result<Vec<u8>> {
    let text = prompt::text(value);
    let data = text
        .strip_prefix("data:image/jpeg;base64,")
        .filter(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"+/=\r\n".contains(&c))
        })
        .ok_or_else(|| Error::invalid(format!("{label}必须是 JPEG 图片")))?;
    if data.len() > 26 * 1024 * 1024 {
        return Err(Error::new(
            413,
            "MAINTENANCE_IMAGE_TOO_LARGE",
            "图片超过请求大小上限",
        ));
    }
    let raw = data
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .take_while(|b| *b != b'=')
        .collect::<Vec<_>>();
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let bytes = decoder
        .decode(raw)
        .map_err(|_| Error::invalid(format!("{label}不是有效的 JPEG 文件")))?;
    if bytes.len() < 4 || !bytes.starts_with(b"\xff\xd8\xff") {
        return Err(Error::invalid(format!("{label}不是有效的 JPEG 文件")));
    }
    Ok(bytes)
}
fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .as_array()
        .or_else(|| value[key].as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn source_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(v @ (Value::Bool(_) | Value::Number(_))) => crate::storage::stringify(v),
        Some(v) => prompt::text(v),
    }
}
fn entry(root: &Path, id: &str) -> Result<Value> {
    let (_, _, scenes) = state::load_scenes(root)?;
    if let Some(scene) = scenes.iter().find(|s| s["id"] == id) {
        let mut entry = json!({});
        for key in ["id", "title", "category", "story", "char", "rating"] {
            if let Some(value) = scene.get(key) {
                entry[key] = value.clone();
            }
        }
        entry["attempt"] = json!(1);
        return Ok(entry);
    }
    let bp = root.join("data/scene-blueprints.json");
    let popular = root.join("data/popular-characters.json");
    if fs::safe(&bp, false, true)?.is_some() && fs::safe(&popular, false, true)?.is_some() {
        let blueprints = fs::json(&bp)?;
        let popular = fs::json(&popular)?;
        if let Some(blueprint) = list(&blueprints, "blueprints").iter().find(|b| {
            b["id"] == id
                || format!(
                    "pc_{}_{}",
                    source_string(b.get("characterId")),
                    source_string(b.get("id"))
                ) == id
        }) {
            let character = list(&popular, "characters")
                .iter()
                .find(|c| c["id"] == blueprint["characterId"]);
            let display = character.and_then(|c| c.get("displayName")).or_else(|| {
                character
                    .is_none()
                    .then(|| blueprint.get("characterId"))
                    .flatten()
            });
            let manifest_id = if id.starts_with("pc_") {
                id.to_string()
            } else {
                format!(
                    "pc_{}_{}",
                    source_string(blueprint.get("characterId")),
                    source_string(blueprint.get("id"))
                )
            };
            let mut entry = json!({"id":manifest_id,"title":format!("{} / {}",source_string(display),source_string(blueprint.get("title"))),"story":if prompt::truthy(&blueprint["description"]){blueprint["description"].clone()}else{json!("")},"category":"热门角色"});
            if let Some(value) = blueprint.get("characterId") {
                entry["char"] = value.clone();
            }
            if let Some(value) = display {
                entry["displayName"] = value.clone();
            }
            entry["rating"] = json!(if prompt::truthy(&blueprint["adult"]) {
                "R18"
            } else {
                "All"
            });
            entry["attempt"] = json!(1);
            entry["type"] = json!("popular");
            return Ok(entry);
        }
    }
    Err(Error::new(
        404,
        "SHOWCASE_SOURCE_NOT_FOUND",
        format!("场景或蓝图不存在，不能保存孤立样张：{id}"),
    ))
}
fn write_showcase(
    options: &Options,
    body: &Value,
    tx: &mut Transaction,
    cancel: &CancellationToken,
    started: Instant,
) -> Result<Value> {
    let root = options.showcase.as_ref().unwrap();
    let text = prompt::text(&body["id"]);
    let id = prompt::trim(&text);
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err(Error::invalid("需要合法场景或蓝图 ID"));
    }
    let mut entry = entry(&options.root, id)?;
    let image = jpeg(&body["image"], "原图")?;
    let thumbnail = if prompt::truthy(&body["thumbnail"]) {
        Some(jpeg(&body["thumbnail"], "缩略图")?)
    } else {
        None
    };
    let thumbnail = thumbnail.as_deref().unwrap_or(&image);
    if image.len() > 15 * 1024 * 1024 || thumbnail.len() > 3 * 1024 * 1024 {
        return Err(Error::new(
            413,
            "MAINTENANCE_IMAGE_TOO_LARGE",
            "原图必须在 15MB 以内，缩略图必须在 3MB 以内",
        ));
    }
    let manifest_path = root.join("manifest.json");
    let mut targets = vec![manifest_path.clone()];
    for ext in ["jpg", "png", "webp"] {
        for folder in ["images", "thumbs"] {
            targets.push(root.join(folder).join(format!("{id}.{ext}")));
        }
    }
    let backup = tx.prepare(&targets, &format!("showcase-{id}"))?;
    transaction_save::check(cancel, started)?;
    tx.write(&root.join("images").join(format!("{id}.jpg")), &image)?;
    tx.write(&root.join("thumbs").join(format!("{id}.jpg")), thumbnail)?;
    for ext in ["png", "webp"] {
        for folder in ["images", "thumbs"] {
            tx.remove(&root.join(folder).join(format!("{id}.{ext}")))?;
        }
    }
    let mut manifest = if fs::safe(&manifest_path, false, true)?.is_some() {
        fs::json(&manifest_path)?
    } else {
        json!({"version":23,"entries":[]})
    };
    if !manifest.is_object() {
        return Err(Error::invalid("样张清单必须为对象"));
    }
    if !manifest["entries"].is_array() {
        manifest["entries"] = json!([]);
    }
    entry["image"] = json!(format!("images/{id}.jpg"));
    entry["thumb"] = json!(format!("thumbs/{id}.jpg"));
    let entries = manifest["entries"].as_array_mut().unwrap();
    if let Some(index) = entries.iter().position(|e| e["id"] == entry["id"]) {
        entries[index] = entry.clone();
    } else {
        entries.push(entry.clone());
    }
    let count = entries.len();
    let popular = entries.iter().filter(|e| e["type"] == "popular").count();
    manifest["entryCount"] = json!(count);
    manifest["sceneCount"] = json!(count);
    if !prompt::truthy(&manifest["counts"]) {
        manifest["counts"] = json!({});
    }
    if !manifest["counts"].is_object() {
        return Err(Error::invalid("样张 counts 必须为对象"));
    }
    manifest["counts"]["popular"] = json!(popular);
    tx.write(&manifest_path, blueprints::json_text(&manifest).as_bytes())?;
    transaction_save::check(cancel, started)?;
    tx.commit()?;
    Ok(
        json!({"ok":true,"file":entry["image"],"thumb":entry["thumb"],"backup":backup,"message":"样张与轻量缩略图已安全保存，旧版本已备份"}),
    )
}
fn number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => {
            if *b {
                1.
            } else {
                0.
            }
        }
        Value::Null => 0.,
        Value::String(s) => {
            let s = prompt::trim(s);
            if s.is_empty() {
                0.
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}
fn write_hero(
    options: &Options,
    body: &Value,
    tx: &mut Transaction,
    cancel: &CancellationToken,
    started: Instant,
) -> Result<Value> {
    let root = options.showcase.as_ref().unwrap();
    let character = prompt::text(&body["character"]);
    if !["nene", "natsume"].contains(&character.as_str()) {
        return Err(Error::invalid("首页主视觉角色无效"));
    }
    let action = if prompt::truthy(&body["action"]) {
        prompt::text(&body["action"])
    } else {
        "replace".into()
    };
    let image_path = root.join("home").join(format!("{character}.jpg"));
    let manifest_path = root.join("home-hero.json");
    let backup = tx.prepare(
        &[image_path.clone(), manifest_path.clone()],
        &format!("home-hero-{character}"),
    )?;
    let mut manifest = showcase::raw_hero(Some(root));
    transaction_save::check(cancel, started)?;
    if action == "reset" {
        tx.remove(&image_path)?;
        manifest["entries"]
            .as_object_mut()
            .unwrap()
            .remove(&character);
    } else {
        let bytes = jpeg(&body["image"], "首页主视觉")?;
        if bytes.len() > 15 * 1024 * 1024 {
            return Err(Error::new(
                413,
                "MAINTENANCE_IMAGE_TOO_LARGE",
                "首页主视觉必须在 15MB 以内",
            ));
        }
        tx.write(&image_path, &bytes)?;
        manifest["entries"][&character] =
            json!({"image":format!("home/{character}.jpg"),"updatedAt":codec::timestamp()});
    }
    let current = if prompt::truthy(&manifest["version"]) {
        number(&manifest["version"])
    } else {
        1.
    };
    manifest["version"] = json!(current + 1.);
    tx.write(&manifest_path, blueprints::json_text(&manifest).as_bytes())?;
    transaction_save::check(cancel, started)?;
    tx.commit()?;
    Ok(
        json!({"ok":true,"character":character,"action":action,"backup":backup,"message":if action=="reset"{"已恢复内置首页主视觉"}else{"首页主视觉已保存"}}),
    )
}
pub(super) fn save(
    options: &Options,
    body: &Value,
    home_hero: bool,
    cancel: &CancellationToken,
) -> Result<Value> {
    let started = Instant::now();
    transaction_save::check(cancel, started)?;
    if options.showcase.is_none() {
        return Err(Error::new(
            503,
            "SHOWCASE_UNAVAILABLE",
            "尚未找到 SceneShowcase 目录",
        ));
    }
    let mut transaction = Transaction::acquire(options)?;
    let result = if home_hero {
        write_hero(options, body, &mut transaction, cancel, started)
    } else {
        write_showcase(options, body, &mut transaction, cancel, started)
    };
    result.map_err(|e| transaction_save::rollback_error(&mut transaction, e))
}
