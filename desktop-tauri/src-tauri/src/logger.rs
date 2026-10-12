use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// 同步文件日志，512KB × 3 轮转，写失败静默降级（与 desktop/logger.ts 同语义）。
#[derive(Clone)]
pub struct FileLogger {
    file_path: std::path::PathBuf,
    writer: Arc<Mutex<()>>,
}

const MAX_BYTES: u64 = 512 * 1024;

impl FileLogger {
    pub fn new(file_path: &Path) -> Self {
        let logger = FileLogger { file_path: file_path.to_path_buf(), writer: Arc::new(Mutex::new(())) };
        let _ = logger.ensure_dir();
        logger
    }

    fn ensure_dir(&self) -> std::io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    fn rotate(&self) {
        if fs::metadata(&self.file_path).map(|m| m.len() < MAX_BYTES).unwrap_or(true) {
            return;
        }
        let _ = fs::remove_file(self.file_path.with_extension("log.2"));
        let _ = fs::rename(self.file_path.with_extension("log.1"), self.file_path.with_extension("log.2"));
        let _ = fs::rename(&self.file_path, self.file_path.with_extension("log.1"));
    }

    pub fn write(&self, level: &str, message: &str) {
        let line = format!("{} [{}] {}\n", crate::now_iso(), level, message);
        // Every producer shares this logger, so rotation and append are one operation.
        let _writer = self.writer.lock().unwrap_or_else(|error| error.into_inner());
        let _ = self.ensure_dir();
        self.rotate();
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.file_path) {
            let _ = file.write_all(line.as_bytes());
        }
    }

    #[allow(dead_code)]
    pub fn info(&self, message: &str) {
        self.write("info", message);
    }

    #[allow(dead_code)]
    pub fn warn(&self, message: &str) {
        self.write("warn", message);
    }

    #[allow(dead_code)]
    pub fn error(&self, message: &str) {
        self.write("error", message);
    }

    pub fn debug(&self, message: &str) {
        self.write("debug", message);
    }
}
