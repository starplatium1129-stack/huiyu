use std::ops::Range;

pub(super) fn finish(bytes: &mut [u8]) -> Option<(Range<usize>, bool)> {
    let (data, pcm) = inspect(bytes)?;
    let length = bytes.len();
    bytes[4..8].copy_from_slice(&((length - 8) as u32).to_le_bytes());
    // Streaming placeholders use the admitted data range, excluding any trailing
    // metadata chunks that still belong to the complete RIFF length above.
    bytes[data.start - 4..data.start].copy_from_slice(&(data.len() as u32).to_le_bytes());
    Some((data, pcm))
}

// A completed HTTP body can still contain a truncated WAV. Accept the empty
// sizes used by streaming WAV headers, but reject partial declared chunks.
fn inspect(bytes: &[u8]) -> Option<(Range<usize>, bool)> {
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let number = |offset: usize| {
        Some(u32::from_le_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?) as usize)
    };
    let riff: usize = number(4)?;
    if riff != bytes.len() - 8 && ![0, 36, u32::MAX as usize].contains(&riff) {
        return None;
    }
    let mut offset = 12;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= bytes.len() {
        let tag = &bytes[offset..offset + 4];
        let declared: usize = number(offset + 4)?;
        let start = offset + 8;
        let size = if tag == b"data" && [0, u32::MAX as usize].contains(&declared) {
            bytes.len() - start
        } else {
            declared
        };
        let end = start.checked_add(size)?;
        if end > bytes.len() {
            return None;
        }
        if tag == b"fmt " {
            if size < 16 || format.is_some() {
                return None;
            }
            let short = |at: usize| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap());
            let encoding = short(start);
            let channels = short(start + 2) as usize;
            let rate: usize = number(start + 4)?;
            let byte_rate: usize = number(start + 8)?;
            let align = short(start + 12) as usize;
            let bits = short(start + 14) as usize;
            if ![1, 3].contains(&encoding)
                || channels == 0
                || rate == 0
                || bits == 0
                || bits % 8 != 0
                || align != channels * (bits / 8)
                || byte_rate != rate.checked_mul(align)?
            {
                return None;
            }
            format = Some((
                align,
                encoding == 1 && channels == 1 && rate == 48000 && bits == 16,
            ));
        } else if tag == b"data" {
            let (align, pcm) = format?;
            if size == 0 || size % align != 0 || data.is_some() {
                return None;
            }
            data = Some((start..end, pcm));
        }
        offset = end.checked_add(size % 2)?;
    }
    if offset != bytes.len() {
        return None;
    }
    data
}
