use std::{
    fs::{File, OpenOptions},
    io,
    path::Path,
};

/// The caller validates the path. Keep the inode: closing the handle or exiting
/// the process releases ownership, even when a previous owner could not clean up.
pub(crate) fn try_lock(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(path).map_err(|error| {
        if cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)) {
            io::Error::new(io::ErrorKind::WouldBlock, error)
        } else {
            error
        }
    })?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: file owns the descriptor for the entire locking call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(not(any(windows, unix)))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "File locking is unavailable",
    ));
    #[cfg(any(windows, unix))]
    Ok(file)
}
