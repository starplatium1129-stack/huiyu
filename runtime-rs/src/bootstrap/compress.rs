use super::*;
use std::io::{Read, Write};
pub(super) fn companions_current(file: &Path, bytes: &[u8]) -> Result<bool> {
    let mut buffer = [0_u8; 64 * 1024];
    for suffix in ["gz", "br"] {
        let companion = PathBuf::from(format!("{}.{}", file.display(), suffix));
        let Some(old) = fs::read(&companion, true)? else {
            continue;
        };
        let reader: Box<dyn Read> = if suffix == "gz" {
            Box::new(flate2::read::GzDecoder::new(old.as_slice()))
        } else {
            Box::new(brotli::Decompressor::new(old.as_slice(), 8192))
        };
        let mut reader = reader.take(bytes.len() as u64 + 1);
        let mut remaining = bytes;
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Ok(false),
            };
            if !remaining.starts_with(&buffer[..read]) {
                return Ok(false);
            }
            remaining = &remaining[read..];
        }
        if !remaining.is_empty() {
            return Ok(false);
        }
    }
    Ok(true)
}
pub(super) fn write(
    file: &Path,
    bytes: &[u8],
    transaction: &Transaction,
    cancel: &CancellationToken,
) -> Result<()> {
    for suffix in ["br", "gz"] {
        cancelled(cancel)?;
        let companion = PathBuf::from(format!("{}.{}", file.display(), suffix));
        if bytes.len() < 1024 {
            transaction.remove(&companion)?;
            continue;
        }
        let packed = if suffix == "br" {
            let mut output = Vec::new();
            let mut reader = std::io::Cursor::new(bytes);
            let parameters = brotli::enc::BrotliEncoderParams {
                quality: 11,
                size_hint: bytes.len(),
                ..Default::default()
            };
            brotli::BrotliCompress(&mut reader, &mut output, &parameters)?;
            output
        } else {
            let mut output = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
            output.write_all(bytes)?;
            output.finish()?
        };
        cancelled(cancel)?;
        if packed.len() < bytes.len() {
            transaction.write(&companion, &packed)?;
        } else {
            transaction.remove(&companion)?;
        }
    }
    Ok(())
}
