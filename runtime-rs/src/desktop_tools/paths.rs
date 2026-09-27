use super::{Error, Result};
use std::path::{Component, Path, PathBuf};

fn inside(root: &Path, file: &Path) -> bool {
    #[cfg(windows)]
    {
        let root = root
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_lowercase();
        let file = file.to_string_lossy().replace('/', "\\").to_lowercase();
        file == root || file.starts_with(&(root + "\\"))
    }
    #[cfg(not(windows))]
    {
        file.starts_with(root)
    }
}
async fn physical(candidate: &Path) -> Result<PathBuf> {
    let mut current = candidate.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        match tokio::fs::symlink_metadata(&current).await {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = current
                    .file_name()
                    .ok_or_else(|| Error::plain("工作区路径不可用"))?
                    .to_owned();
                suffix.push(name);
                if !current.pop() {
                    return Err(Error::plain("工作区路径不可用"));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    // A dangling junction/symlink reaches this canonicalize call and fails; it
    // must never be treated as a missing writable directory.
    let mut result = tokio::fs::canonicalize(current).await?;
    for part in suffix.into_iter().rev() {
        result.push(part);
    }
    Ok(result)
}
pub(super) async fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    let clean = relative.trim().replace('\\', "/");
    if clean.starts_with('/')
        || (clean.len() > 1
            && clean.as_bytes()[0].is_ascii_alphabetic()
            && clean.as_bytes()[1] == b':')
    {
        return Err(Error::plain("只接受工作区内的相对路径"));
    }
    if clean.split('/').any(|part| part == "..") {
        return Err(Error::plain("路径不能包含 .."));
    }
    if clean.contains('\0') || (cfg!(windows) && clean.contains(':')) {
        return Err(Error::plain("路径包含无效字符"));
    }
    let root = std::path::absolute(root)?;
    let mut candidate = root.clone();
    for part in Path::new(&clean).components() {
        match part {
            Component::Normal(part) => candidate.push(part),
            Component::CurDir => {}
            _ => return Err(Error::plain("只接受工作区内的相对路径")),
        }
    }
    if !inside(&root, &candidate) {
        return Err(Error::plain("路径超出 AI 工作区范围"));
    }
    let physical_root = physical(&root).await?;
    let physical = physical(&candidate).await?;
    if !inside(&physical_root, &physical) {
        return Err(Error::plain("路径链接指向 AI 工作区外，已拒绝访问"));
    }
    Ok(physical)
}
pub(super) fn display(path: &Path) -> String {
    #[cfg(windows)]
    {
        path.to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .to_owned()
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}
pub(super) async fn relative(root: &Path, path: &Path) -> String {
    if let Ok(root) = physical(root).await
        && let Ok(relative) = path.strip_prefix(root)
        && !relative.as_os_str().is_empty()
    {
        return display(relative);
    }
    path.file_name()
        .map(|part| part.to_string_lossy().into_owned())
        .unwrap_or_default()
}
