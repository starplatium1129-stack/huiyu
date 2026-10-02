use super::*;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
};
pub(super) fn read_json(directory: &Path, name: &str) -> Result<Value> {
    let path = schema::safe(directory, name)?;
    if !fs::metadata(&path)?.is_file() {
        return Err(invalid_backup("Backup metadata is not a regular file"));
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
pub(super) fn marker(directory: &Path, name: &str, value: &Value) -> Result<()> {
    schema::write_new(&schema::safe(directory, format!("{name}.pending"))?, value)?;
    let target = schema::safe(directory, name)?;
    if target.exists() {
        return Err(invalid_backup("Workspace completion marker already exists"));
    }
    fs::rename(schema::safe(directory, format!("{name}.pending"))?, target)?;
    schema::sync_dir(directory)
}
pub(super) fn prepare_directory(c: &Files, relative: &str, identity: &str) -> Result<PathBuf> {
    let directory = schema::safe(&c.root, relative)?;
    fs::create_dir_all(directory.parent().unwrap())?;
    if directory.exists() {
        let marker = schema::safe(&directory, "incomplete.json")?;
        let recorded: Value = if marker.exists() {
            read_json(&directory, "incomplete.json")?
        } else {
            Value::Null
        };
        if (recorded["identity"] != identity || recorded["workspaceId"] != c.workspace_id)
            && fs::read_dir(&directory)?.next().is_some()
        {
            return Err(invalid_backup(
                "Incomplete backup directory ownership could not be verified",
            ));
        }
        // Both directory names are generated from a persisted operation digest. Validate
        // the full subtree before recursive removal so a junction cannot escape root.
        check_tree(&directory)?;
        fs::remove_dir_all(&directory)?;
    }
    fs::create_dir(&directory)?;
    schema::write_new(
        &directory.join("incomplete.json"),
        &json!({"identity":identity,"workspaceId":c.workspace_id}),
    )?;
    Ok(directory)
}
fn check_tree(directory: &Path) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file = schema::safe(directory, entry.file_name())?;
        if entry.file_type()?.is_dir() {
            check_tree(&file)?;
        }
    }
    Ok(())
}
pub(super) fn digest_file(c: &Files, file: &Path) -> Result<Value> {
    let (bytes, sha256, _) = media::hash_file_checked(&c.root, file, || c.check_cancel())?;
    Ok(json!({"bytes":bytes,"sha256":sha256}))
}
pub(super) fn copy(
    c: &Files,
    source: &Path,
    target: &Path,
    relative: &str,
    expected: &Value,
) -> Result<()> {
    let from = schema::safe(source, relative)?;
    let to = schema::safe(target, relative)?;
    if !fs::metadata(&from)?.is_file() {
        return Err(invalid_backup("Backup source is not a regular file"));
    }
    fs::create_dir_all(to.parent().unwrap())?;
    let mut input = File::open(from)?;
    let mut output = OpenOptions::new().create_new(true).write(true).open(&to)?;
    let mut buffer = vec![0; media::CHUNK];
    loop {
        c.check_cancel()?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
    }
    output.sync_all()?;
    drop(output);
    if digest_file(c, &to)? != *expected {
        return Err(invalid_backup("Backup file hash or size mismatch"));
    }
    schema::sync_dir(to.parent().unwrap())
}
