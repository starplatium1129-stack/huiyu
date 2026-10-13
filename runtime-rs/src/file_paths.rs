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
    if let Some(Component::Prefix(prefix)) = output.components().next() {
        use std::{
            ffi::OsString,
            os::windows::ffi::{OsStrExt, OsStringExt},
            path::Prefix,
        };
        // Only disk/UNC prefixes have an equivalent non-verbatim spelling.
        // Stripping a generic volume/device namespace would make it relative.
        let wide: Vec<u16> = match prefix.kind() {
            Prefix::VerbatimDisk(_) => output.as_os_str().encode_wide().skip(4).collect(),
            Prefix::VerbatimUNC(_, _) => [b'\\' as u16, b'\\' as u16]
                .into_iter()
                .chain(output.as_os_str().encode_wide().skip(8))
                .collect(),
            _ => return Ok(output),
        };
        return Ok(PathBuf::from(OsString::from_wide(&wide)));
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
