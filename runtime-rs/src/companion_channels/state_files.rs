use super::{ApiError, AppState, Result, Settings, Storage};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotStore {
    #[serde(default)]
    bots: Vec<Settings>,
}

fn settings_path(app: &AppState, storage: &Storage, principal: &str) -> PathBuf {
    state_path(app, storage, principal, &json!(["qq", "settings"]))
}

fn bots_path(app: &AppState, storage: &Storage, principal: &str) -> PathBuf {
    state_path(app, storage, principal, &json!(["qq", "bots"]))
}

pub(super) async fn read_bots(
    app: &AppState,
    storage: &Storage,
    principal: &str,
) -> Result<Vec<Settings>> {
    if let Some(store) = read::<BotStore>(&bots_path(app, storage, principal)).await? {
        return Ok(store.bots);
    }
    if let Some(legacy) = read::<Settings>(&settings_path(app, storage, principal)).await? {
        return Ok(vec![legacy]);
    }
    Ok(Vec::new())
}

pub(super) async fn write_bots(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    bots: &[Settings],
) -> Result<()> {
    write(
        &bots_path(app, storage, principal),
        &BotStore {
            bots: bots.to_vec(),
        },
    )
    .await
}

pub(super) async fn read_bot(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    bot_id: &str,
) -> Result<Option<Settings>> {
    Ok(read_bots(app, storage, principal)
        .await?
        .into_iter()
        .find(|bot| bot.id == bot_id))
}

pub(super) async fn read_bot_by_app_id(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    app_id: &str,
) -> Result<Option<Settings>> {
    Ok(read_bots(app, storage, principal)
        .await?
        .into_iter()
        .find(|bot| bot.app_id == app_id))
}

pub(super) fn state_path(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    slot: &Value,
) -> PathBuf {
    let key = crate::storage::json_fingerprint(&json!([storage.workspace_id(), principal, slot]));
    app.config
        .runtime_root
        .join("state/companion-channels")
        .join(format!("{key}.json"))
}

pub(super) async fn read<T: DeserializeOwned>(file: &Path) -> Result<Option<T>> {
    match tokio::fs::read(file).await {
        Ok(data) => serde_json::from_slice(&data)
            .map(Some)
            .map_err(|_| ApiError::invalid("本机消息连接记录无法读取")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn write<T: Serialize>(file: &Path, value: &T) -> Result<()> {
    let parent = file.parent().expect("channel state directory");
    tokio::fs::create_dir_all(parent).await?;
    let (output, pending) = tempfile::NamedTempFile::new_in(parent)?.into_parts();
    let mut output = tokio::fs::File::from_std(output);
    output.write_all(&serde_json::to_vec(value)?).await?;
    output.sync_all().await?;
    drop(output);
    pending.persist(file).map_err(|error| error.error)?;
    Ok(())
}
