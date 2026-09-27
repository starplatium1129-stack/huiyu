use super::*;
use std::io::{Read, Write};
pub(super) fn companions_current(file: &Path, bytes: &[u8]) -> Result<bool> {
    for suffix in ["gz", "br"] {
        let companion = PathBuf::from(format!("{}.{}", file.display(), suffix));
        let Some(old) = fs::read(&companion, true)? else {
            continue;
        };
        let mut decoded = Vec::with_capacity(bytes.len());
        let reader: Box<dyn Read> = if suffix == "gz" {
            Box::new(flate2::read::GzDecoder::new(old.as_slice()))
        } else {
            Box::new(brotli::Decompressor::new(old.as_slice(), 8192))
        };
        if reader
            .take(bytes.len() as u64 + 1)
            .read_to_end(&mut decoded)
            .is_err()
            || decoded != bytes
        {
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
