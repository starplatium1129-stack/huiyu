use super::{Error, Result, Value, lines::FRAME_LIMIT};

pub(super) enum Frame {
    Event(Value),
    Done,
}

#[derive(Default)]
pub(super) struct Frames {
    partial: String,
    started: bool,
}

impl Frames {
    pub(super) fn push(&mut self, line: &str) -> Result<Option<Frame>> {
        let line = if self.started {
            line
        } else {
            self.started = true;
            line.strip_prefix('\u{feff}').unwrap_or(line)
        };
        let line = line.trim();
        if line.is_empty() {
            if self.partial.is_empty() {
                return Ok(None);
            }
            let event = serde_json::from_str(&self.partial).map_err(|_| invalid())?;
            self.partial.clear();
            return Ok(Some(Frame::Event(event)));
        }
        let Some(data) = line.strip_prefix("data:") else {
            return Ok(None);
        };
        let data = data.trim();
        if !self.partial.is_empty() {
            if self.partial.len() + 1 + data.len() > FRAME_LIMIT {
                return Err(Error::stream("STREAM_BUDGET", "响应超过单帧预算"));
            }
            self.partial.push('\n');
            self.partial.push_str(data);
            return Ok(None);
        }
        if data.is_empty() {
            return Ok(None);
        }
        if data == "[DONE]" {
            return Ok(Some(Frame::Done));
        }
        // Legacy compatible gateways send one complete JSON value per line.
        // Only an unfinished value needs buffering until the SSE blank line.
        match serde_json::from_str(data) {
            Ok(event) => Ok(Some(Frame::Event(event))),
            Err(error) if error.is_eof() => {
                if data.len() > FRAME_LIMIT {
                    return Err(Error::stream("STREAM_BUDGET", "响应超过单帧预算"));
                }
                self.partial.push_str(data);
                Ok(None)
            }
            Err(_) => Err(invalid()),
        }
    }

    pub(super) fn end(&self, terminal: bool) -> Result<()> {
        if self.partial.is_empty() && terminal {
            Ok(())
        } else {
            Err(invalid())
        }
    }
}

fn invalid() -> Error {
    Error::stream("INVALID_SSE", "自定义 API 返回了畸形 SSE")
}
