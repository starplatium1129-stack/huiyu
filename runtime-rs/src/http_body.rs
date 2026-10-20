//! Bounded response collection; callers retain status, timeout and error policy.
use crate::byte_buffer::Buffer;
use axum::body::Bytes;
use futures_util::StreamExt;

pub(crate) enum ReadError {
    Network(reqwest::Error),
    TooLarge,
}

pub(crate) async fn collect(
    response: reqwest::Response,
    limit: usize,
) -> Result<Buffer, ReadError> {
    let mut stream = response.bytes_stream();
    let mut bytes = Buffer::Chunk(Bytes::new());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(ReadError::Network)?;
        if bytes.as_ref().len().saturating_add(chunk.len()) > limit {
            return Err(ReadError::TooLarge);
        }
        bytes.append(chunk, 0);
    }
    Ok(bytes)
}
