use super::*;
pub(super) fn run(c: &Files, kind: &CopyKind) -> Result<Value> {
    match kind {
        CopyKind::Restore {
            backup_id,
            candidate_id,
        } => restore_backup(c, backup_id, candidate_id),
        CopyKind::Backup {
            directory,
            manifest,
            existing,
        } => {
            let mut manifest = manifest.clone();
            if !existing {
                for item in manifest["media"].as_array().unwrap() {
                    let hash = string(item, "hash")?;
                    copy(
                        c,
                        &c.root,
                        directory,
                        &object_relative(hash)?,
                        &json!({"bytes":item["bytes"],"sha256":hash}),
                    )?;
                }
                schema::write_new(
                    &directory.join("workspace.json"),
                    &json!({"workspaceId":c.workspace_id,"databaseKind":"huiyu-workspace","schemaVersion":3}),
                )?;
                manifest["database"] = digest_file(c, &directory.join("huiyu.sqlite3"))?;
            }
            verify_snapshot(c, directory, &manifest)?;
            c.check_cancel()?;
            if !existing {
                marker(directory, "manifest.json", &manifest)?;
            }
            Ok(
                json!({"backupId":manifest["backupId"],"revision":manifest["revision"],"mediaCount":manifest["media"].as_array().unwrap().len()}),
            )
        }
    }
}
pub(super) fn restore_backup(c: &Files, backup_id: &str, id: &str) -> Result<Value> {
    valid_id(backup_id)?;
    valid_id(id)?;
    c.check_cancel()?;
    let source = schema::safe(&c.root, format!("backups/{backup_id}"))?;
    let manifest = manifest(c, &source, backup_id)?;
    verify_snapshot(c, &source, &manifest)?;
    let existing = schema::safe(&c.root, format!("restore-candidates/{id}"))?;
    if schema::safe(&existing, "candidate.json")?.exists() {
        let marker: Value = serde_json::from_slice(&fs::read(existing.join("candidate.json"))?)?;
        if marker["backupId"] != backup_id
            || marker["candidateId"] != id
            || marker["workspaceId"] != c.workspace_id
            || marker["activated"] != false
            || marker["state"] != "verified"
        {
            return Err(invalid_backup("Restore candidate identity mismatch"));
        }
        verify_snapshot(c, &existing, &manifest)?;
    } else {
        let destination = prepare_directory(
            c,
            &format!("restore-candidates/{id}"),
            &format!("{backup_id}:{id}"),
        )?;
        copy(
            c,
            &source,
            &destination,
            "huiyu.sqlite3",
            &manifest["database"],
        )?;
        for item in manifest["media"].as_array().unwrap() {
            let hash = string(item, "hash")?;
            copy(
                c,
                &source,
                &destination,
                &object_relative(hash)?,
                &json!({"bytes":item["bytes"],"sha256":hash}),
            )?;
        }
        schema::write_new(
            &destination.join("workspace.json"),
            &json!({"workspaceId":c.workspace_id,"databaseKind":"huiyu-workspace","schemaVersion":manifest["schemaVersion"]}),
        )?;
        verify_snapshot(c, &destination, &manifest)?;
        c.check_cancel()?;
        marker(
            &destination,
            "candidate.json",
            &json!({"formatVersion":1,"state":"verified","backupId":backup_id,"candidateId":id,"workspaceId":c.workspace_id,"revision":manifest["revision"],"activated":false}),
        )?;
    }
    Ok(
        json!({"candidateId":id,"revision":manifest["revision"],"mediaCount":manifest["media"].as_array().unwrap().len()}),
    )
}
