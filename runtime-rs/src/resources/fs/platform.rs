use super::*;
pub(in crate::resources) fn hostname() -> Result<String> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetComputerNameExW(kind: i32, buffer: *mut u16, length: *mut u32) -> i32;
        }
        let mut buffer = [0_u16; 256];
        let mut count = buffer.len() as u32;
        if unsafe { GetComputerNameExW(1, buffer.as_mut_ptr(), &mut count) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(String::from_utf16_lossy(&buffer[..count as usize]))
    }
    #[cfg(unix)]
    {
        let mut bytes = [0_u8; 256];
        if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        Ok(String::from_utf8_lossy(&bytes[..end]).into_owned())
    }
}
pub(in crate::resources) fn space(path: &Path, needed: u64) -> Result<()> {
    #[cfg(windows)]
    let available = {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetDiskFreeSpaceExW(
                path: *const u16,
                available: *mut u64,
                total: *mut u64,
                free: *mut u64,
            ) -> i32;
        }
        let text = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let (mut available, mut total, mut free) = (0, 0, 0);
        if unsafe { GetDiskFreeSpaceExW(text.as_ptr(), &mut available, &mut total, &mut free) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        available
    };
    #[cfg(unix)]
    let available = {
        use std::os::unix::ffi::OsStrExt;
        let text = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| Error::new("UNSAFE_PATH", "Invalid volume path"))?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(text.as_ptr(), stat.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let stat = unsafe { stat.assume_init() };
        let bytes = u128::from(stat.f_bavail) * u128::from(stat.f_frsize);
        bytes.min(u128::from(u64::MAX)) as u64
    };
    if available < needed {
        Err(Error::new(
            "ENOSPC",
            "Not enough free space; previous installation retained",
        ))
    } else {
        Ok(())
    }
}
