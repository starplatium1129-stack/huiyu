use super::*;
use crate::file_identity::{self, Identity, Version};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

type Stamp = (Identity, Version);
struct Tail {
    stamp: Stamp,
    lines: Vec<Arc<String>>,
}
#[derive(Default)]
pub(super) struct Cache {
    // Fixed runtime paths only; no handles or unredacted log contents survive a read.
    tails: [Option<Tail>; 3],
}
fn stamp(file: &File) -> std::io::Result<Stamp> {
    Ok((file_identity::opened(file)?, Version::of(file)?))
}
fn current(file: &File, path: &Path, expected: &Stamp) -> bool {
    stamp(file).ok().as_ref() == Some(expected)
        && File::open(path).and_then(|file| stamp(&file)).ok().as_ref() == Some(expected)
}
fn read_tail(
    service: &ControlService,
    path: &Path,
    previous: Option<Tail>,
) -> std::io::Result<(Vec<Arc<String>>, Option<Tail>)> {
    // Reopen on every poll, including hits: deletion, replacement and denied
    // read access must never be hidden by a remembered tail.
    let mut file = File::open(path)?;
    let before = stamp(&file).ok();
    if let Some(previous) = previous
        && before.as_ref() == Some(&previous.stamp)
        && current(&file, path, &previous.stamp)
    {
        return Ok((previous.lines.clone(), Some(previous)));
    }
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(64 * 1024)))?;
    let mut bytes = Vec::new();
    (&mut file).take(64 * 1024).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<_> = text
        .lines()
        .rev()
        .filter(|line| !line.is_empty())
        .take(30)
        .map(|line| Arc::new(service.redact(line)))
        .collect();
    lines.reverse();
    // Reuse the existing identity/version authority, including change time.
    // Unstable reads or unsupported identity APIs keep the ordinary fresh-read path.
    let next = before
        .filter(|before| current(&file, path, before))
        .map(|stamp| Tail {
            stamp,
            lines: lines.clone(),
        });
    Ok((lines, next))
}
impl ControlService {
    pub(super) async fn file_logs(self: &Arc<Self>) -> Vec<Arc<String>> {
        let cancel = self.shutdown.child_token();
        let _guard = cancel.clone().drop_guard();
        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut lines = Vec::new();
            for (index, name) in ["gateway.log", "tunnel.log", "control.log"]
                .iter()
                .enumerate()
            {
                // A blocking read cannot be interrupted, but dropped requests and
                // shutdown must not continue on to the remaining log files.
                if cancel.is_cancelled() {
                    break;
                }
                let path = service.config.runtime_root.join("logs").join(name);
                // Taking first also clears the slot on any open/metadata/read failure.
                let previous = service.log_tails.lock().unwrap().tails[index].take();
                if let Ok((tail, next)) = read_tail(&service, &path, previous) {
                    lines.extend(tail);
                    // Concurrent readers may publish out of order; every later
                    // reuse still reopens the path and validates the full stamp.
                    service.log_tails.lock().unwrap().tails[index] = next;
                }
            }
            lines
        })
        .await
        .unwrap_or_default()
    }
}
