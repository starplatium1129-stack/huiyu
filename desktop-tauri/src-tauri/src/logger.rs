use crate::mutex::RecoverMutex;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Desktop logs share a buffered append handle and retain two rotated files.
#[derive(Clone)]
pub struct FileLogger {
    file_path: PathBuf,
    state: Arc<Mutex<WriterState>>,
}

#[derive(Default)]
struct WriterState {
    file: Option<LogFile>,
    flush_scheduled: bool,
    rotate_retry_after: Option<Instant>,
}

struct LogFile {
    writer: BufWriter<File>,
    day: u64,
    bytes: u64,
}

impl Drop for LogFile {
    fn drop(&mut self) {
        let _ = self.writer.flush();
    }
}

const MAX_BYTES: u64 = 512 * 1024;
const FLUSH_DELAY: Duration = Duration::from_millis(250);
const ROTATE_BACKOFF: Duration = Duration::from_secs(30);

fn seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

impl FileLogger {
    pub fn new(file_path: &Path) -> Self {
        Self { file_path: file_path.to_path_buf(), state: Arc::new(Mutex::default()) }
    }

    fn open(&self, day: u64) -> std::io::Result<LogFile> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&self.file_path)?;
        let metadata = file.metadata()?;
        let bytes = metadata.len();
        let day = metadata.modified().ok().filter(|_| bytes != 0)
            .map_or(day, |time| seconds(time) / 86_400);
        Ok(LogFile { writer: BufWriter::new(file), day, bytes })
    }

    fn rotate(&self) -> std::io::Result<()> {
        let first = self.file_path.with_extension("log.1");
        let second = self.file_path.with_extension("log.2");
        let _ = fs::remove_file(&second);
        let _ = fs::rename(&first, &second);
        fs::rename(&self.file_path, first)
    }

    fn append(&self, state: &mut WriterState, day: u64, line: &[u8]) -> std::io::Result<()> {
        if state.file.is_none() {
            state.file = Some(self.open(day)?);
        }
        let needs_rotate = state.file.as_ref().is_some_and(|file| file.bytes != 0 && (
            file.day != day || file.bytes.saturating_add(line.len() as u64) > MAX_BYTES
        ));
        if needs_rotate && state.rotate_retry_after.is_none_or(|at| Instant::now() >= at) {
            // Close the append handle before renaming on Windows.
            if let Some(mut file) = state.file.take() {
                file.writer.flush()?;
            }
            if self.rotate().is_ok() {
                state.rotate_retry_after = None;
            } else {
                // Avoid per-line close/rename/reopen thrashing if a viewer holds desktop.log open.
                state.rotate_retry_after = Some(Instant::now() + ROTATE_BACKOFF);
            }
            state.file = Some(self.open(day)?);
        }
        if let Some(file) = state.file.as_mut() {
            file.writer.write_all(line)?;
            file.bytes += line.len() as u64;
            file.day = day;
        }
        Ok(())
    }

    pub fn write(&self, level: &str, message: &str) {
        let timestamp = seconds(SystemTime::now());
        let line = format!("{timestamp} [{level}] {message}\n");
        let mut state = self.state.recover_lock();
        if self.append(&mut state, timestamp / 86_400, line.as_bytes()).is_err() {
            state.file = None;
            return;
        }
        if matches!(level, "warn" | "error") {
            Self::flush_file(&mut state);
        } else if !state.flush_scheduled {
            state.flush_scheduled = true;
            drop(state);
            let logger = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FLUSH_DELAY).await;
                let mut state = logger.state.recover_lock();
                state.flush_scheduled = false;
                Self::flush_file(&mut state);
            });
        }
    }

    fn flush_file(state: &mut WriterState) {
        if state.file.as_mut().is_some_and(|file| file.writer.flush().is_err()) {
            state.file = None;
        }
    }

    pub fn flush(&self) {
        Self::flush_file(&mut self.state.recover_lock());
    }

    pub fn debug(&self, message: &str) {
        self.write("debug", message);
    }
}
