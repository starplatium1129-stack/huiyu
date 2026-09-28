use super::{Duration, Error, Result};
use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use std::pin::Pin;

const FRAME_LIMIT: usize = 1024 * 1024;
const TOTAL_LIMIT: usize = 16 * FRAME_LIMIT;

pub(super) struct Lines {
    source: Pin<Box<dyn Stream<Item = std::result::Result<Bytes, reqwest::Error>> + Send>>,
    buffer: Vec<u8>,
    start: usize,
    scanned: usize,
    total: usize,
    ended: bool,
    idle: Duration,
}

impl Lines {
    pub(super) fn new(
        source: Pin<Box<dyn Stream<Item = std::result::Result<Bytes, reqwest::Error>> + Send>>,
        idle: Duration,
    ) -> Self {
        Self {
            source,
            buffer: Vec::new(),
            start: 0,
            scanned: 0,
            total: 0,
            ended: false,
            idle,
        }
    }

    pub(super) async fn next(&mut self) -> Result<Option<String>> {
        loop {
            let newline = self.buffer[self.scanned..]
                .iter()
                .position(|b| *b == b'\n')
                .map(|index| self.scanned + index);
            let end = newline.unwrap_or(self.buffer.len());
            if end - self.start > FRAME_LIMIT {
                return Err(Error::stream("STREAM_BUDGET", "响应超过单帧预算"));
            }
            if let Some(index) = newline {
                let line = String::from_utf8_lossy(&self.buffer[self.start..index]).into_owned();
                self.start = index + 1;
                self.scanned = self.start;
                return Ok(Some(line));
            }
            self.scanned = self.buffer.len();
            if self.ended {
                if self.start == self.buffer.len() {
                    return Ok(None);
                }
                let line = String::from_utf8_lossy(&self.buffer[self.start..]).into_owned();
                self.start = self.buffer.len();
                return Ok(Some(line));
            }
            match tokio::time::timeout(self.idle, self.source.next())
                .await
                .map_err(|_| Error::stream("UPSTREAM_TIMEOUT", "聊天流超时"))?
            {
                Some(Ok(chunk)) => {
                    self.total = self.total.saturating_add(chunk.len());
                    if self.total > TOTAL_LIMIT {
                        return Err(Error::stream("STREAM_BUDGET", "响应超过总字节预算"));
                    }
                    // Consume lines by cursor; move the partial tail once per chunk,
                    // not once per line. Keep the scan cursor across fragmented frames.
                    if self.start > 0 {
                        self.buffer.copy_within(self.start.., 0);
                        self.buffer.truncate(self.buffer.len() - self.start);
                        self.scanned -= self.start;
                        self.start = 0;
                    }
                    self.buffer.extend_from_slice(&chunk);
                }
                Some(Err(_)) => return Err(Error::stream("INCOMPLETE_STREAM", "聊天流中断")),
                None => self.ended = true,
            }
        }
    }
}

#[cfg(test)]
mod tests;
