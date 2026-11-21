use crate::file_paths;
use sevenz_rust2::{ArchiveReader, Password};
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    time::Instant,
};

pub(crate) fn cli(args: &[String]) -> io::Result<Option<()>> {
    if args.get(1).map(String::as_str) != Some("extract-7z") {
        return Ok(None);
    }
    if args.len() != 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "用法: huiyu-runtime extract-7z <archive> <destination>",
        ));
    }
    extract(Path::new(&args[2]), Path::new(&args[3]))?;
    Ok(Some(()))
}

fn is_reparse_or_symlink(path: &Path) -> io::Result<bool> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_clean_ancestors(root: &Path, target: &Path) -> io::Result<()> {
    let Ok(relative) = target.strip_prefix(root) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "压缩包路径越出目标目录",
        ));
    };
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        if cursor.exists() && is_reparse_or_symlink(&cursor)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "禁止通过符号链接或重解析点解压文件",
            ));
        }
    }
    Ok(())
}

fn safe_relative(name: &str) -> io::Result<PathBuf> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains(':')
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.bytes().any(|b| b == 0 || b < 0x20)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("压缩包包含非法路径：{name}"),
        ));
    }
    let normalized = trimmed.replace('\\', "/");
    let mut out = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("压缩包包含上级目录跳转：{name}"),
            ));
        }
        out.push(segment);
    }
    if out.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("压缩包路径无效：{name}"),
        ));
    }
    Ok(out)
}

fn process_entry(
    entry: &sevenz_rust2::ArchiveEntry,
    reader: &mut dyn io::Read,
    root: &Path,
    total: u64,
    done: &mut u64,
    last_report: &mut Instant,
) -> std::result::Result<bool, sevenz_rust2::Error> {
    *done += 1;
    if entry.is_anti_item {
        return Ok(true);
    }
    let rel =
        safe_relative(entry.name()).map_err(|e| sevenz_rust2::Error::Other(e.to_string().into()))?;
    if rel.as_os_str().is_empty() {
        return Ok(true);
    }
    let target = root.join(&rel);
    ensure_clean_ancestors(root, &target)
        .map_err(|e| sevenz_rust2::Error::Other(e.to_string().into()))?;
    if entry.is_directory {
        fs::create_dir_all(&target)?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
            ensure_clean_ancestors(root, parent)
                .map_err(|e| sevenz_rust2::Error::Other(e.to_string().into()))?;
        }
        let mut out = File::create(&target)?;
        io::copy(reader, &mut out)?;
        out.flush()?;
    }
    if last_report.elapsed().as_millis() >= 200 || *done == total {
        *last_report = Instant::now();
        eprintln!(
            "HUIYU:ENV|{done}|{total}|正在解压（{done}/{total}）：{}",
            rel.display()
        );
    }
    Ok(true)
}

fn extract(archive: &Path, destination: &Path) -> io::Result<()> {
    if !archive.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "待解压的 .7z 文件不存在",
        ));
    }
    fs::create_dir_all(destination)?;
    if is_reparse_or_symlink(destination)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "目标目录不能是符号链接或重解析点",
        ));
    }
    let root = file_paths::absolute(destination)?;
    let mut reader = ArchiveReader::open(archive, Password::empty())
        .map_err(|e| io::Error::other(format!("无法打开 .7z 运行包：{e}")))?;
    let total = reader.archive().files.len() as u64;
    let mut done = 0u64;
    let mut last_report = Instant::now();
    reader
        .for_each_entries(|entry, reader| {
            process_entry(entry, reader, &root, total, &mut done, &mut last_report)
        })
        .map_err(|e| io::Error::other(format!("解压 .7z 运行包失败：{e}")))?;
    Ok(())
}
