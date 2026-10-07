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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};

    #[test]
    fn verbatim_normalization_preserves_absolute_roots_and_utf16() {
        for (source, expected) in [
            (r"\\?\C:\用户\绘遇", r"C:\用户\绘遇"),
            (r"\\?\UNC\server\share\绘遇", r"\\server\share\绘遇"),
            (
                r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\资源",
                r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\资源",
            ),
            (
                r"\\?\GLOBALROOT\Device\HarddiskVolume1\资源",
                r"\\?\GLOBALROOT\Device\HarddiskVolume1\资源",
            ),
            (r"C:\用户\旧\..\绘遇", r"C:\用户\绘遇"),
        ] {
            let path = absolute(Path::new(source)).unwrap();
            assert!(path.is_absolute(), "{source}");
            assert_eq!(path, Path::new(expected));
        }
        let source: Vec<_> = r"\\?\C:\资源\".encode_utf16().chain([0xd800]).collect();
        let expected: Vec<_> = r"C:\资源\".encode_utf16().chain([0xd800]).collect();
        assert_eq!(
            absolute(Path::new(&OsString::from_wide(&source))).unwrap(),
            PathBuf::from(OsString::from_wide(&expected))
        );
    }
}
