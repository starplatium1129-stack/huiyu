use std::{fs::File, io::Result, time::SystemTime};

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Version {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
}
impl Version {
    pub(crate) fn of(file: &File) -> Result<Self> {
        let stat = file.metadata()?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            len: stat.len(),
            modified: stat.modified().ok(),
            created: stat.created().ok(),
            #[cfg(unix)]
            inode: stat.ino(),
            #[cfg(unix)]
            changed: (stat.ctime(), stat.ctime_nsec()),
            #[cfg(windows)]
            changed: windows_change_time(file)?,
        })
    }
}
#[cfg(windows)]
fn windows_change_time(file: &File) -> Result<i64> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct BasicInfo {
        creation: i64,
        access: i64,
        write: i64,
        change: i64,
        attributes: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            file: *mut c_void,
            class: i32,
            information: *mut c_void,
            size: u32,
        ) -> i32;
    }
    let mut info = BasicInfo::default();
    // ChangeTime also detects writes whose original mtime was restored.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            0,
            (&mut info as *mut BasicInfo).cast(),
            std::mem::size_of::<BasicInfo>() as u32,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(info.change)
}
