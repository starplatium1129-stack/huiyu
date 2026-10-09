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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logger_writes_and_rotates() {
        let tmp = std::env::temp_dir().join(format!("aics-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("desktop.log");
        let logger = FileLogger::new(&file);
        logger.info("hello");
        assert!(fs::read_to_string(&file).unwrap().contains("hello"));
        // 轮转：先写入超过上限的内容，下一次写入前触发 rotate
        let big = "x".repeat(600 * 1024);
        logger.write("debug", &big);
        logger.info("after-big");
        let has_rotated = file.with_extension("log.1").exists();
        assert!(has_rotated);
        // 当前文件应该是小内容（轮转后重新开始）
        assert!(fs::metadata(&file).map(|m| m.len()).unwrap_or(0) < 100_000);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn concurrent_producers_preserve_records_across_rotation() {
        let tmp = std::env::temp_dir().join(format!("aics-log-concurrent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let file = tmp.join("desktop.log");
        let logger = FileLogger::new(&file);
        std::thread::scope(|scope| {
            for producer in 0..4 {
                let logger = logger.clone();
                scope.spawn(move || {
                    for index in 0..180 {
                        logger.debug(&format!("{producer}:{index}:{}", "x".repeat(1024)));
                    }
                });
            }
        });
        let contents: String = [file.clone(), file.with_extension("log.1"), file.with_extension("log.2")]
            .into_iter().filter_map(|path| fs::read_to_string(path).ok()).collect();
        let records: std::collections::HashSet<_> = contents.lines()
            .map(|line| line.split_once(" [debug] ").unwrap().1).collect();
        assert_eq!(contents.lines().count(), 720);
        assert_eq!(records.len(), 720);
        for producer in 0..4 {
            for index in 0..180 {
                assert!(records.contains(format!("{producer}:{index}:{}", "x".repeat(1024)).as_str()));
            }
        }
        assert!(file.with_extension("log.1").is_file());
        fs::remove_dir_all(tmp).unwrap();
    }
}
