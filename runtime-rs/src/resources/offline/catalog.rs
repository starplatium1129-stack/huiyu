use super::{Error, Options, Result, Value, fs, json, release::Release};
use crate::catalog::{Catalog, Options as CatalogOptions};

fn error(error: crate::error::ApiError) -> Error {
    Error::new(&error.code, error.message)
}

// Only called after exclusive runtime admission. Previewing a ZIP never opens
// (and therefore never initializes) the user's database.
pub(super) fn prepare(options: &Options, release: &Release) -> Result<Option<Catalog>> {
    let Some(snapshot) = &release.catalog else {
        return Ok(None);
    };
    // Import may precede the first desktop launch. Seed the complete personal
    // data directory before opening SQLite, otherwise startup sees an existing
    // content directory and correctly refuses to silently reseed it.
    options.gateway().prepare_content_for(true).map_err(error)?;
    let mut catalog = Catalog::open(CatalogOptions {
        source: options.app.clone(),
        database: options.runtime.join("content/catalog.sqlite"),
    })
    .map_err(error)?;
    catalog.import(snapshot, true).map_err(error)?;
    let backup = options
        .runtime
        .join("content-update-backups")
        .join(&options.expected);
    let before = backup.join("before.json");
    if !before.exists() {
        fs::ensure(&backup)?;
        fs::write_json(&before, &catalog.snapshot().map_err(error)?)?;
    }
    Ok(Some(catalog))
}

pub(super) fn apply(
    options: &Options,
    release: &Release,
    catalog: &mut Option<Catalog>,
) -> Result<Value> {
    let Some(catalog) = catalog else {
        return Ok(
            json!({"included":false,"message":"此旧素材包不含人物内容，请使用包含内容快照的新素材包。"}),
        );
    };
    let receipt = catalog
        .import(release.catalog.as_ref().unwrap(), false)
        .map_err(error)?;
    fs::write_json(
        &options
            .runtime
            .join("content-update-backups")
            .join(&options.expected)
            .join("receipt.json"),
        &receipt,
    )?;
    Ok(
        json!({"included":true,"changed":receipt["items"].as_array().unwrap().len(),"version":receipt["version"]}),
    )
}
