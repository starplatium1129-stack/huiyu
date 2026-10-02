use std::{
    io::Result,
    path::{Component, Path, PathBuf},
};

// Lexical normalization only; each caller retains its own link and root policy.
pub(crate) fn absolute(path: &Path) -> Result<PathBuf> {
    let path = std::path::absolute(path)?;
    let mut output = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            part => output.push(part.as_os_str()),
        }
    }
    #[cfg(windows)]
    {
        let text = output.to_string_lossy();
        if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
            return Ok(PathBuf::from(format!("\\\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix("\\\\?\\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(output)
}

pub(crate) fn key(path: &Path) -> Result<String> {
    let value = absolute(path)?.to_string_lossy().into_owned();
    Ok(if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    })
}
