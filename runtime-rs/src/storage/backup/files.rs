use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write, Seek, SeekFrom},
};
pub(super) fn read_json(directory: &Path, name: &str) -> Result<Value> {
    let path = schema::safe(directory, name)?;
    if !fs::metadata(&path)?.is_file() {
        return Err(invalid_backup("Backup metadata is not a regular file"));
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
pub(super) fn marker(directory: &Path, name: &str, value: &Value) -> Result<()> {
    let target = schema::safe(directory, name)?;
    if target.exists() {
        if read_json(directory,name)? == *value { return Ok(()); }
        return Err(invalid_backup("Workspace completion marker already exists with different content"));
    }
    let pending = schema::safe(directory, format!("{name}.{}.pending",uuid::Uuid::new_v4()))?;
    schema::write_new(&pending, value)?;
    fs::rename(pending, target)?;
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
        // A matching incomplete marker owns resumable files. Validate the subtree
        // but retain completed objects and partial bytes across cancellation/restart.
        check_tree(c,&directory)?;
        if recorded["identity"] == identity && recorded["workspaceId"] == c.workspace_id { return Ok(directory); }
    } else {
        fs::create_dir(&directory)?;
    }
    schema::write_new(
        &directory.join("incomplete.json"),
        &json!({"identity":identity,"workspaceId":c.workspace_id}),
    )?;
    Ok(directory)
}
fn check_tree(c: &Files, directory: &Path) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        c.check_cancel()?;
        let entry = entry?;
        let file = schema::safe(directory, entry.file_name())?;
        if entry.file_type()?.is_dir() {
            check_tree(c,&file)?;
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
    if to.exists() {
        if digest_file(c,&to)? == *expected { return Ok(()); }
        return Err(invalid_backup("Existing completed backup file differs from the snapshot"));
    }
    let pending = schema::safe(target,format!("{relative}.copying"))?;
    let mut input = File::open(from)?;
    let mut output = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&pending)?;
    let mut buffer = vec![0; media::CHUNK];
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let retained = output.metadata()?.len();
    let mut previous = vec![0; media::CHUNK];
    while bytes < retained {
        c.check_cancel()?;
        let count = ((retained-bytes) as usize).min(buffer.len());
        if input.read_exact(&mut buffer[..count]).is_err() || output.read_exact(&mut previous[..count]).is_err() || buffer[..count] != previous[..count] {
            output.set_len(0)?; output.seek(SeekFrom::Start(0))?; input.seek(SeekFrom::Start(0))?;
            bytes=0; hash=Sha256::new(); break;
        }
        hash.update(&buffer[..count]); bytes += count as u64;
        c.progress("resuming-file",bytes,expected["bytes"].as_u64().unwrap_or(0));
    }
    loop {
        c.check_cancel()?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
        hash.update(&buffer[..count]);
        bytes += count as u64;
        c.progress("copying-file",bytes,expected["bytes"].as_u64().unwrap_or(0));
    }
    output.sync_all()?;
    drop(output);
    c.check_cancel()?;
    // Check the bytes actually copied, including changes to the source during
    // the copy. Every caller verifies the destination snapshot before publishing.
    if json!({"bytes":bytes,"sha256":hex::encode(hash.finalize())}) != *expected {
        return Err(invalid_backup("Backup file hash or size mismatch"));
    }
    fs::rename(pending,&to)?;
    schema::sync_dir(to.parent().unwrap())
}
