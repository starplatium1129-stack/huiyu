use super::*;
pub(super) fn backup(c: &Files, id: &str, source: Option<(Connection, i64)>) -> Result<Value> {
    c.check_cancel()?;
    let relative = format!("backups/{id}");
    let directory = schema::safe(&c.root, &relative)?;
    let published = schema::safe(&directory, "manifest.json")?.try_exists()?;
    let manifest = if published {
        drop(source);
        manifest(c, &directory, id)?
    } else {
        prepare_directory(c, &relative, id)?;
        let manifest = if schema::safe(&directory, "snapshot.json")?.try_exists()? {
            drop(source);
            validate_manifest(c, read_json(&directory, "snapshot.json")?, id)?
        } else {
            let (source, revision) =
                source.ok_or_else(|| invalid_backup("Backup snapshot is missing"))?;
            let media = media_rows(c, &source)?;
            copy_database(c, source, &directory, id)?;
            let database = digest_file(c, &directory.join("huiyu.sqlite3"))?;
            let mut value = json!({"formatVersion":1,"kind":"huiyu-workspace-backup","backupId":id,
                "workspaceId":c.workspace_id,"schemaVersion":schema::VERSION,"revision":revision,
                "media":null,"database":database});
            value["media"] = Value::Array(media);
            marker(&directory, "snapshot.json", &value)?;
            value
        };
        let items = manifest["media"].as_array().unwrap();
        for (index, item) in items.iter().enumerate() {
            c.progress("copying-media", index as u64, items.len() as u64);
            let hash = string(item, "hash")?;
            copy(
                c,
                &c.root,
                &directory,
                &object_relative(hash)?,
                &json!({"bytes":item["bytes"],"sha256":hash}),
            )?;
        }
        marker(
            &directory,
            "workspace.json",
            &json!({"workspaceId":c.workspace_id,"databaseKind":"huiyu-workspace","schemaVersion":manifest["schemaVersion"]}),
        )?;
        manifest
    };
    c.progress("verifying-backup", 0, 1);
    // Verify against the digest captured when the SQLite copy was first sealed.
    verify_snapshot(c, &directory, &manifest)?;
    c.check_cancel()?;
    if !published {
        marker(&directory, "manifest.json", &manifest)?;
    }
    Ok(
        json!({"backupId":id,"revision":manifest["revision"],"mediaCount":manifest["media"].as_array().unwrap().len()}),
    )
}
pub(super) fn restore_backup(c: &Files, backup_id: &str, id: &str) -> Result<Value> {
    valid_id(backup_id)?;
    valid_id(id)?;
    c.check_cancel()?;
    let source = schema::safe(&c.root, format!("backups/{backup_id}"))?;
    let manifest = manifest(c, &source, backup_id)?;
    c.progress("verifying-source", 0, 1);
    verify_snapshot(c, &source, &manifest)?;
    let existing = schema::safe(&c.root, format!("restore-candidates/{id}"))?;
    if schema::safe(&existing, "candidate.json")?.exists() {
        let marker = read_json(&existing, "candidate.json")?;
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
        marker(
            &destination,
            "workspace.json",
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
