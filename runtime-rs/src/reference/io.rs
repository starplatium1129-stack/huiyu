use super::{Result, unavailable};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Take},
    path::Path,
};

const MAX_FILE: u64 = 64 * 1024 * 1024;

pub(super) fn no_links(path: &Path) -> Result<()> {
    for parent in path.ancestors() {
        match fs::symlink_metadata(parent) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(unavailable());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err(unavailable());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(unavailable()),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn single_link(file: &File) -> bool {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Information {
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
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            output: *mut Information,
        ) -> i32;
    }
    let mut value = std::mem::MaybeUninit::<Information>::uninit();
    // Stable std metadata does not expose link count on Windows. This fixed Win32
    // ABI preserves the Node reader's nlink=1 boundary without another dependency.
    unsafe {
        GetFileInformationByHandle(file.as_raw_handle(), value.as_mut_ptr()) != 0
            && value.assume_init().links == 1
    }
}

#[cfg(unix)]
fn single_link(file: &File) -> bool {
    use std::os::unix::fs::MetadataExt;
    file.metadata().is_ok_and(|meta| meta.nlink() == 1)
}

#[cfg(not(any(windows, unix)))]
fn single_link(_: &File) -> bool {
    false
}

fn open(path: &Path) -> Result<(Take<File>, u64)> {
    no_links(path)?;
    let file = File::open(path).map_err(|_| unavailable())?;
    let meta = file.metadata().map_err(|_| unavailable())?;
    if !meta.is_file() || meta.len() > MAX_FILE || !single_link(&file) {
        return Err(unavailable());
    }
    Ok((file.take(MAX_FILE + 1), meta.len()))
}

pub(super) fn bytes(path: &Path) -> Result<Vec<u8>> {
    let (mut file, size) = open(path)?;
    let mut data = Vec::with_capacity(size as usize);
    file.read_to_end(&mut data).map_err(|_| unavailable())?;
    if data.len() as u64 != size {
        return Err(unavailable());
    }
    Ok(data)
}

pub(super) fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

pub(super) fn file_digest(path: &Path) -> Result<(u64, String)> {
    let (mut file, size) = open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut actual = 0;
    loop {
        let length = file.read(&mut buffer).map_err(|_| unavailable())?;
        if length == 0 {
            break;
        }
        actual += length as u64;
        hash.update(&buffer[..length]);
    }
    if actual != size {
        return Err(unavailable());
    }
    Ok((size, hex::encode(hash.finalize())))
}

pub(super) fn json(path: &Path) -> Result<serde_json::Value> {
    serde_json::from_slice(&bytes(path)?).map_err(|_| unavailable())
}
