use super::{Error, Result, codec, identity};
use crate::file_paths::{absolute, key};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub(crate) fn same(left: &Path, right: &Path) -> bool {
    matches!((key(left),key(right)),(Ok(left),Ok(right)) if left==right)
}
pub(crate) fn within(root: &Path, file: &Path) -> bool {
    let Ok(root) = key(root) else {
        return false;
    };
    let Ok(file) = key(file) else {
        return false;
    };
    file.starts_with(
        &(root.trim_end_matches(std::path::MAIN_SEPARATOR).to_owned()
            + std::path::MAIN_SEPARATOR_STR),
    )
}
pub(crate) fn safe(path: &Path, directory: bool, missing: bool) -> Result<Option<fs::Metadata>> {
    let path = absolute(path)?;
    let mut cursor = PathBuf::new();
    let parts = path.components().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        cursor.push(part.as_os_str());
        if !matches!(part, Component::Normal(_)) {
            continue;
        }
        let name = part.as_os_str().to_string_lossy();
        let stem = name.split('.').next().unwrap_or("").to_lowercase();
        if name
            .chars()
            .any(|c| c <= '\u{1f}' || ":*?\"<>|".contains(c))
            || name.ends_with(['.', ' '])
            || ["con", "prn", "aux", "nul"].contains(&stem.as_str())
            || ((stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(Error::path("不安全的维护路径"));
        }
        let metadata = match fs::symlink_metadata(&cursor) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && missing => {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() || !same(&fs::canonicalize(&cursor)?, &cursor) {
            return Err(Error::path("拒绝符号链接或 junction"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(Error::path("拒绝重解析点"));
            }
        }
        let last = index + 1 == parts.len();
        if if !last || directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        } {
            return Err(Error::path("文件类型不符"));
        }
        if last {
            if metadata.is_file() && identity::path(&cursor, false)?.links != 1 {
                return Err(Error::path("拒绝硬链接文件"));
            }
            return Ok(Some(metadata));
        }
    }
    if !directory {
        return Err(Error::path("目标不能是文件系统根"));
    }
    Ok(Some(fs::metadata(path)?))
}
pub(crate) fn directory_identity(path: &Path) -> Result<Value> {
    safe(path, true, false)?;
    let identity = identity::path(path, true)?;
    Ok(json!({"path":key(path)?,"dev":identity.dev.to_string(),"ino":identity.ino.to_string()}))
}
pub(crate) fn read(path: &Path, missing: bool) -> Result<Option<Vec<u8>>> {
    if safe(path, false, missing)?.is_none() {
        return Ok(None);
    }
    let mut file = File::open(path)?;
    let before = file.metadata()?;
    let before_id = identity::opened(&file)?;
    safe(path, false, false)?;
    if identity::path(path, false)? != before_id || !before.is_file() {
        return Err(Error::conflict("读取期间文件被替换"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let after = safe(path, false, false)?.unwrap();
    if identity::path(path, false)? != before_id
        || after.len() != before.len()
        || after.modified()? != before.modified()?
    {
        return Err(Error::conflict("读取期间文件发生变化"));
    }
    Ok(Some(bytes))
}
pub(crate) fn json(path: &Path) -> Result<Value> {
    let bytes = read(path, false)?.unwrap();
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(Error::journal("元数据过大"));
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::journal("元数据不是有效 JSON"))
}
pub(crate) fn state(path: &Path) -> Result<Value> {
    Ok(match read(path, true)? {
        None => json!({"exists":false,"sha256":null,"size":0}),
        Some(bytes) => json!({"exists":true,"sha256":codec::digest(&bytes),"size":bytes.len()}),
    })
}
pub(crate) fn ensure(path: &Path) -> Result<()> {
    if safe(path, true, true)?.is_some() {
        return Ok(());
    }
    let parent = path.parent().ok_or_else(|| Error::path("目录根不可用"))?;
    ensure(parent)?;
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    safe(path, true, false)?;
    Ok(())
}
pub(crate) fn sync(path: &Path) -> Result<()> {
    #[cfg(not(windows))]
    File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}
pub(crate) fn atomic(path: &Path, bytes: &[u8], parents: bool) -> Result<()> {
    let parent = path.parent().ok_or_else(|| Error::path("目录根不可用"))?;
    if parents {
        ensure(parent)?;
    }
    safe(parent, true, false)?;
    let old = safe(path, false, true)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(
            old.as_ref()
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0o600),
        );
    }
    #[cfg(not(unix))]
    let _ = old;
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        safe(path, false, true)?;
        fs::rename(&temporary, path)?;
        sync(parent)
    })();
    let _ = fs::remove_file(&temporary);
    result
}
pub(crate) fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|_| Error::journal("元数据序列化失败"))?;
    bytes.push(b'\n');
    atomic(path, &bytes, false)
}
pub(crate) fn remove(path: &Path) -> Result<()> {
    if safe(path, false, true)?.is_some() {
        fs::remove_file(path)?;
        sync(path.parent().unwrap())?;
    }
    Ok(())
}
