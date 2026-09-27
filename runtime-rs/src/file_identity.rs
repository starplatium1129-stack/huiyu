use std::io::Result;
use std::{fs::File, path::Path};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    pub dev: u64,
    pub ino: u64,
    pub links: u64,
}

#[cfg(windows)]
pub(crate) fn opened(file: &File) -> Result<Identity> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Info {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    let mut info = std::mem::MaybeUninit::<Info>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(Identity {
        dev: info.volume as u64,
        ino: ((info.index_high as u64) << 32) | info.index_low as u64,
        links: info.links as u64,
    })
}
#[cfg(unix)]
pub(crate) fn opened(file: &File) -> Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(Identity {
        dev: metadata.dev(),
        ino: metadata.ino(),
        links: metadata.nlink(),
    })
}
#[cfg(not(any(windows, unix)))]
pub(crate) fn opened(_: &File) -> Result<Identity> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "File identity is unavailable on this platform",
    ))
}

pub(crate) fn path(file: &Path, directory: bool) -> Result<Identity> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(if directory { 0x02000000 } else { 0 });
    }
    #[cfg(not(windows))]
    let _ = directory;
    opened(&options.open(file)?)
}
