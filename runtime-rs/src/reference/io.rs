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

fn open(path: &Path) -> Result<(Take<File>, u64)> {
    no_links(path)?;
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
