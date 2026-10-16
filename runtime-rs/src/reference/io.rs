use super::{Result, check_cancel, unavailable};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Take},
    path::Path,
};
use tokio_util::sync::CancellationToken;

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

fn open(path: &Path) -> Result<(Take<File>, u64)> {
    no_links(path)?;
    // Reject existing FIFOs/devices before open can block. The opened handle is
    // still checked below; this preflight does not exclude concurrent replacement.
    if !fs::metadata(path).map_err(|_| unavailable())?.is_file() {
        return Err(unavailable());
    }
    let file = File::open(path).map_err(|_| unavailable())?;
    let meta = file.metadata().map_err(|_| unavailable())?;
    if !meta.is_file()
        || meta.len() > MAX_FILE
        || !crate::file_identity::opened(&file).is_ok_and(|identity| identity.links == 1)
    {
        return Err(unavailable());
    }
    Ok((file.take(MAX_FILE + 1), meta.len()))
}

pub(super) fn bytes(path: &Path, cancel: &CancellationToken) -> Result<Vec<u8>> {
    check_cancel(cancel)?;
    let (mut file, size) = open(path)?;
    let mut data = Vec::with_capacity(size as usize);
    loop {
        check_cancel(cancel)?;
        let length = file
            .by_ref()
            .take(64 * 1024)
            .read_to_end(&mut data)
            .map_err(|_| unavailable())?;
        if length == 0 {
            break;
        }
    }
    check_cancel(cancel)?;
    if data.len() as u64 != size {
        return Err(unavailable());
    }
    Ok(data)
}

pub(super) fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

pub(super) fn file_digest(path: &Path, cancel: &CancellationToken) -> Result<(u64, String)> {
    check_cancel(cancel)?;
    let (mut file, size) = open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut actual = 0;
    loop {
        check_cancel(cancel)?;
        let length = file.read(&mut buffer).map_err(|_| unavailable())?;
        if length == 0 {
            break;
        }
        actual += length as u64;
        hash.update(&buffer[..length]);
    }
    check_cancel(cancel)?;
    if actual != size {
        return Err(unavailable());
    }
    Ok((size, hex::encode(hash.finalize())))
}

pub(super) fn json(path: &Path, cancel: &CancellationToken) -> Result<serde_json::Value> {
    let value = serde_json::from_slice(&bytes(path, cancel)?).map_err(|_| unavailable())?;
    check_cancel(cancel)?;
    Ok(value)
}
