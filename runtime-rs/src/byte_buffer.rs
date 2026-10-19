use axum::body::Bytes;

pub(crate) enum Buffer {
    Chunk(Bytes),
    Joined(Vec<u8>),
}
impl AsRef<[u8]> for Buffer {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Chunk(bytes) => bytes.as_ref(),
            Self::Joined(bytes) => bytes.as_slice(),
        }
    }
}
impl Buffer {
    // Callers check budgets before appending; start marks the consumed prefix.
    pub(crate) fn append(&mut self, chunk: Bytes, start: usize) {
        if start == self.as_ref().len() {
            *self = Self::Chunk(chunk);
        } else {
            match self {
                Self::Chunk(bytes) => {
                    if chunk.is_empty() {
                        if start > 0 {
                            *bytes = bytes.slice(start..);
                        }
                        return;
                    }
                    let tail = &bytes[start..];
                    let mut joined = Vec::with_capacity(tail.len() + chunk.len());
                    joined.extend_from_slice(tail);
                    joined.extend_from_slice(&chunk);
                    *self = Self::Joined(joined);
                }
                Self::Joined(bytes) => {
                    if start > 0 {
                        bytes.copy_within(start.., 0);
                        bytes.truncate(bytes.len() - start);
                    }
                    bytes.extend_from_slice(&chunk);
                }
            }
        }
    }
    pub(crate) fn into_vec(self) -> Vec<u8> {
        match self {
            Self::Chunk(bytes) => bytes.into(),
            Self::Joined(bytes) => bytes,
        }
    }
}
