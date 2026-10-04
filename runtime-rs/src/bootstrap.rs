mod compress;
pub(crate) mod tags;
#[cfg(test)]
mod tests;
use crate::{
    config::Config,
    maintenance::{self, Error, Options, Result, blueprints, fs, transaction::Transaction},
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;
const PRODUCTS: &[&str] = &[
    "scenes.json",
    "scenes-nene.json",
    "scenes-natsume.json",
    "scenes-shared.json",
    "scenes-core.json",
    "scenes-index.json",
    "popular-characters.json",
    "scene-blueprints.json",
    "tags.json",
    "tags-dictionary.json",
    "character-reference-standards.json",
    "character-reference-view.json",
];
fn invalid(message: impl Into<String>) -> Error {
    Error {
        status: axum::http::StatusCode::CONFLICT,
        code: "DATA_BUILD_INVALID".into(),
        message: message.into(),
        extra: Box::new(json!({})),
    }
}
fn cancelled(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(invalid("启动聚合已取消"))
    } else {
        Ok(())
    }
}
struct Plan {
    outputs: Vec<(PathBuf, Vec<u8>)>,
    count: usize,
    mode: &'static str,
    extra_compress: Vec<PathBuf>,
}
fn plan(root: &Path, face: &str) -> Result<Plan> {
    let (items, count, mode) = match face {
        "scenes" => {
            let (_, scenes) = maintenance::state::load_scenes(root)?;
            let count = scenes.len();
            (
                maintenance::scenes::scene_products(root, &scenes),
                count,
                "compressed",
            )
        }
        "popular" => {
            let characters = blueprints::load_popular(root)?;
            let count = characters.len();
            (
                vec![(
                    "popular-characters.json",
                    json!({"version":1,"characters":characters}),
                )],
                count,
                "compressed",
            )
        }
        "blueprints" => {
            let blueprints = blueprints::load(root)?;
            let count = blueprints.len();
            (
                vec![(
                    "scene-blueprints.json",
                    json!({"version":2,"blueprints":blueprints}),
                )],
                count,
                "compressed",
            )
        }
        "tags" => {
            let (tags, dictionary) = tags::load(root)?;
            let count = tags.len();
            (
                vec![
                    ("tags.json", json!(tags)),
                    ("tags-dictionary.json", dictionary),
                ],
                count,
                "tags",
            )
        }
        "references" => {
            let (standards, view) =
                crate::reference::source_products(root).map_err(|error| invalid(error.message))?;
            let count = standards["characters"].as_array().unwrap().len();
            (
                vec![
                    ("character-reference-standards.json", standards),
                    ("character-reference-view.json", view),
                ],
                count,
                "references",
            )
        }
        _ => unreachable!(),
    };
    Ok(Plan {
        outputs: items
            .into_iter()
            .map(|(name, value)| {
                (
                    root.join("data").join(name),
                    blueprints::json_text(&value).into_bytes(),
                )
            })
            .collect(),
        count,
        mode,
        extra_compress: if face == "tags" {
            vec![root.join("data/tags/manifest.json")]
        } else {
            Vec::new()
        },
    })
}
fn current(plan: &Plan) -> Result<bool> {
    for (file, expected) in &plan.outputs {
        let Some(bytes) = fs::read(file, true)? else {
            return Ok(false);
        };
        if &bytes != expected {
            return Ok(false);
        }
        if plan.mode == "tags" && !compress::companions_current(file, &bytes)? {
            return Ok(false);
        }
    }
    Ok(true)
}
fn face(options: &Options, name: &str, cancel: &CancellationToken) -> Result<Value> {
    cancelled(cancel)?;
    let token = maintenance::journal::read_token(options)?;
    let candidate = plan(&options.root, name)?;
    let is_current = current(&candidate)?;
    maintenance::journal::assert_token(options, &token)?;
    if is_current {
        return Ok(json!({"rebuilt":false}));
    }
    let mut transaction = Transaction::acquire(options)?;
    let result: Result<Value> = (|| {
        // Re-read under the shared maintenance lease: the first read is only an
        // inexpensive no-write decision, never the source of a delayed write.
        let candidate = plan(&options.root, name)?;
        let mut targets = Vec::new();
        for (file, _) in &candidate.outputs {
            targets.push(file.clone());
            targets.extend([
                PathBuf::from(format!("{}.gz", file.display())),
                PathBuf::from(format!("{}.br", file.display())),
            ]);
        }
        for file in &candidate.extra_compress {
            targets.extend([
                PathBuf::from(format!("{}.gz", file.display())),
                PathBuf::from(format!("{}.br", file.display())),
            ]);
        }
        transaction.prepare(&targets, &format!("data-build-{name}"))?;
        for (file, bytes) in &candidate.outputs {
            cancelled(cancel)?;
            let changed = fs::read(file, true)?.as_ref() != Some(bytes);
            if changed || candidate.mode == "tags" {
                transaction.write(file, bytes)?;
            }
            if candidate.mode == "references" {
                if changed {
                    for suffix in ["gz", "br"] {
                        transaction.remove(&PathBuf::from(format!(
                            "{}.{}",
                            file.display(),
                            suffix
                        )))?;
                    }
                }
            } else {
                compress::write(file, bytes, &transaction, cancel)?;
            }
        }
        for file in &candidate.extra_compress {
            let bytes = fs::read(file, false)?.unwrap();
            compress::write(file, &bytes, &transaction, cancel)?;
        }
        cancelled(cancel)?;
        transaction.commit()?;
        Ok(json!({"rebuilt":true,"count":candidate.count}))
    })();
    result.map_err(|error| {
        let rollback = transaction.rollback();
        let mut error = error;
        error.extra["rolledBack"] = rollback.is_ok().into();
        error.extra["recoveryRequired"] = rollback.is_err().into();
        if let Err(rollback) = rollback {
            error.extra["recovery"] = rollback.message.into();
        }
        error
    })
}
/// Explicit startup operation. Run in a blocking worker before opening the
/// listener. It never mutates canonical shards, prompts, or reference media.
pub fn ensure(config: &Config, cancel: &CancellationToken) -> Result<Value> {
    run(
        config,
        cancel,
        std::env::var("AICS_DESKTOP_PACKAGED").as_deref() == Ok("1"),
    )
}
fn run(config: &Config, cancel: &CancellationToken, packaged: bool) -> Result<Value> {
    cancelled(cancel)?;
    let options = Options {
        assets_root: Some(config.assets_root()),
        root: config.content_root_for(packaged),
        runtime: config.runtime_root.clone(),
        showcase: None,
    };
    let mut result = json!({});
    if packaged {
        for name in PRODUCTS {
            if fs::safe(&options.root.join("data").join(name), false, true)?.is_none() {
                return Err(invalid(format!("发布包缺少聚合产物：{name}")));
            }
        }
        for face in ["scenes", "popular", "blueprints", "tags", "references"] {
            result[face] = json!({"rebuilt":false});
        }
        result["packaged"] = true.into();
        return Ok(result);
    }
    for name in ["scenes", "popular", "blueprints", "tags", "references"] {
        if options.root.join("data/catalog/manifest.json").is_file()
            && ["scenes", "popular", "blueprints"].contains(&name)
        {
            result[name] = json!({"rebuilt":false,"source":"catalog-snapshot"});
            continue;
        }
        result[name] = face(&options, name, cancel)?;
    }
    Ok(result)
}
