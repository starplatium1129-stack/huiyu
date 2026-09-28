use libloading::Library;
use std::path::Path;

pub(crate) fn open(path: &Path) -> std::result::Result<Library, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("Native DLL requires an existing absolute path".into());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "Native DLL path is unavailable")?;
    // Only this explicitly selected DLL directory and System32 may supply
    // dependencies. Uploaded/model directories and the CWD cannot supply code.
    #[cfg(windows)]
    let loaded = unsafe {
        libloading::os::windows::Library::load_with_flags(&path, 0x00000100 | 0x00000800)
            .map(Library::from)
    };
    #[cfg(not(windows))]
    let loaded = unsafe { Library::new(&path) };
    loaded.map_err(|_| "Native library could not be loaded".into())
}
