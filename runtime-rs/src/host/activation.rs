use crate::{
    AppState,
    error::{ApiError, Result},
    storage::Storage,
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

fn config_root(state: &AppState) -> Result<&Path> {
    state.config.config_root.as_deref().ok_or_else(|| {
        ApiError::new(
            501,
            "HOST_CONFIG_REQUIRED",
            "Host migration requires an explicit desktop config root",
        )
    })
}

pub(super) async fn prepare(state: &AppState) -> Result<()> {
    if state.host.selected().is_some() {
        return Ok(());
    }
    if state.host.storage().is_some() {
        return Err(ApiError::new(
            409,
            "WORKSPACE_BUSY",
            "An explicitly opened workspace cannot be replaced by a migration candidate",
        ));
    }
    let root = config_root(state)?;
    let id = Uuid::new_v4().to_string();
    let pointer = json!({"formatVersion": 1, "workspaceId": id, "generation": 1, "domains": [], "activatedRevision": 0,
        "migrationId": null, "backupId": null, "restoreCandidateId": null, "bundledUi": false});
    let workspace_root = checked(root, &format!("workspaces/{id}"))?;
    let storage = tokio::time::timeout(
        Duration::from_secs(30),
        Storage::open(workspace_root, id, true),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            504,
            "WORKSPACE_TIMEOUT",
            "Opening migration candidate timed out",
        )
    })??
    .with_native_images(crate::native_images::library_path(&state.config));
    if let Err(error) = write_pointer(root, &pointer, true) {
        storage.close().await?;
        return Err(error);
    }
    state.host.install(storage, pointer, true);
    Ok(())
}

pub(super) async fn activate(state: &AppState, migration_id: &str, bundled: bool) -> Result<()> {
    let root = config_root(state)?;
    let active = state.host.active();
    if active.as_ref().is_some_and(|pointer| {
        pointer["migrationId"] == migration_id && pointer["bundledUi"] == bundled
    }) {
        return Ok(());
    }
    let storage = state.host.storage().ok_or_else(|| {
        ApiError::new(
            503,
            "WORKSPACE_UNAVAILABLE",
            "Migration candidate is not open",
        )
    })?;
    let principal = format!(
        "desktop:{}",
        state.config.source_profile_id.as_deref().unwrap_or("")
    );
    let migration = execute(
        &storage,
        &principal,
        json!({"kind": "migration.status", "migrationId": migration_id}),
    )
    .await?;
    let already_active = active
        .as_ref()
        .is_some_and(|pointer| pointer["migrationId"] == migration_id);
    let has_domain = |domain: &str| {
        migration["domains"]
            .as_array()
            .is_some_and(|domains| domains.iter().any(|item| item == domain))
    };
    if (migration["state"] != "verified" && !(already_active && migration["state"] == "activated"))
        || !migration["blockers"].as_array().is_some_and(Vec::is_empty)
        || migration["source"]["sourceProfileId"].as_str()
            != state.config.source_profile_id.as_deref()
        || !has_domain("artwork")
        || (bundled
            && !["artwork", "settings", "chat", "draft"]
                .iter()
                .all(|domain| has_domain(domain)))
    {
        return Err(ApiError::new(
            409,
            "MIGRATION_NOT_VERIFIED",
            "All requested source domains must be verified before activation",
        ));
    }
    if !already_active
        && execute(&storage, &principal, json!({"kind": "status"})).await?["revision"]
            != migration["revision"]
    {
        return Err(ApiError::new(
            409,
            "ACTIVATION_CHANGED",
            "Candidate changed after source verification",
        ));
    }
    let backup = execute(
        &storage,
        &principal,
        json!({"kind": "backup", "operationId": Uuid::new_v4().to_string()}),
    )
    .await?;
    let restored = execute(&storage, &principal, json!({"kind": "restoreBackup", "operationId": Uuid::new_v4().to_string(), "backupId": backup["backupId"]})).await?;
    let status = execute(&storage, &principal, json!({"kind": "status"})).await?;
    if restored["revision"] != backup["revision"]
        || restored["mediaCount"] != backup["mediaCount"]
        || status["revision"] != backup["revision"]
    {
        return Err(ApiError::new(
            409,
            "ACTIVATION_CHANGED",
            "Candidate changed during backup verification; keep source frozen and retry",
        ));
    }
    let generation = active
        .as_ref()
        .and_then(|p| p["generation"].as_u64())
        .unwrap_or(0)
        + 1;
    if generation > 9_007_199_254_740_991 {
        return Err(ApiError::new(
            409,
            "WORKSPACE_IDENTITY",
            "Workspace generation exceeds the supported range",
        ));
    }
    let next = json!({"formatVersion": 1, "workspaceId": storage.workspace_id(), "generation": generation,
        "domains": migration["domains"], "activatedRevision": status["revision"], "migrationId": migration_id,
        "backupId": backup["backupId"], "restoreCandidateId": restored["candidateId"], "bundledUi": bundled});
    // This tiny durable rename is deliberately synchronous: cancellation must
    // not release maintenance while a detached worker still publishes authority.
    write_pointer(root, &next, false)?;
    state.host.install(storage.clone(), next, false);
    execute(
        &storage,
        &principal,
        json!({"kind": "migration.activate", "operationId": format!("activate:{migration_id}"),
        "migrationId": migration_id, "expectedFingerprint": migration["fingerprint"]}),
    )
    .await?;
    Ok(())
}

async fn execute(storage: &Storage, principal: &str, command: Value) -> Result<Value> {
    let seconds = if matches!(command["kind"].as_str(), Some("backup" | "restoreBackup")) {
        120
    } else {
        30
    };
    tokio::time::timeout(
        Duration::from_secs(seconds),
        storage.request(command, principal),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            504,
            "WORKSPACE_TIMEOUT",
            "Host workspace operation timed out",
        )
    })?
}

fn checked(root: &Path, name: &str) -> Result<PathBuf> {
    let path = root.join(name);
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, std::path::Component::ParentDir) {
            return Err(ApiError::invalid("Workspace pointer path is not canonical"));
        }
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApiError::invalid(
                    "Workspace pointer symlinks are not supported",
                ));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    Ok(path)
}

fn write_pointer(root: &Path, pointer: &Value, candidate: bool) -> Result<()> {
    let name = if candidate {
        "workspace-candidate.json"
    } else {
        "workspace-active.json"
    };
    let target = checked(root, name)?;
    let temporary = checked(root, &format!("{name}.{}.pending", Uuid::new_v4()))?;
    fs::create_dir_all(root)?;
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(pointer)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, target)?;
        #[cfg(not(windows))]
        fs::File::open(root)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
