use crate::models::LogEntry;
use chrono::Local;
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_LOG_BYTES: u64 = 1_048_576;
const KEEP_FILES: usize = 5;
const UI_LOG_LIMIT: usize = 500;

pub struct SafeLogger {
    directory: PathBuf,
    entries: Mutex<VecDeque<LogEntry>>,
    write_lock: Mutex<()>,
}

impl SafeLogger {
    pub fn new(directory: PathBuf) -> Self {
        let _ = fs::create_dir_all(&directory);
        let mut history = VecDeque::new();
        for index in (0..=KEEP_FILES).rev() {
            let name = if index == 0 {
                "heartopia-photo.log".to_owned()
            } else {
                format!("heartopia-photo.log.{index}")
            };
            if let Ok(file) = fs::File::open(directory.join(name)) {
                let mut bytes = Vec::new();
                let _ = file.take(MAX_LOG_BYTES + 1024).read_to_end(&mut bytes);
                for line in String::from_utf8_lossy(&bytes).lines() {
                    if let Ok(mut entry) = serde_json::from_str::<LogEntry>(line) {
                        entry.message = sanitize(&entry.message);
                        if !matches!(entry.level.as_str(), "info" | "warn" | "error") {
                            entry.level = "info".into();
                        }
                        history.push_back(entry);
                        while history.len() > UI_LOG_LIMIT {
                            history.pop_front();
                        }
                    }
                }
            }
        }
        Self {
            directory,
            entries: Mutex::new(history),
            write_lock: Mutex::new(()),
        }
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    // Only internally generated operation codes/counts reach this interface.
    // Never pass paths, filenames, upstream error strings, credentials or environment values.
    pub fn add(&self, level: &str, message: &str) -> LogEntry {
        let entry = LogEntry {
            timestamp: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            level: level.into(),
            message: sanitize(message),
        };
        let mut entries = self.entries.lock();
        entries.push_back(entry.clone());
        while entries.len() > UI_LOG_LIMIT {
            entries.pop_front();
        }
        drop(entries);
        let _guard = self.write_lock.lock();
        let path = self.directory.join("heartopia-photo.log");
        if fs::metadata(&path).is_ok_and(|m| m.len() >= MAX_LOG_BYTES) {
            self.rotate();
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            if let Ok(line) = serde_json::to_string(&entry) {
                let _ = writeln!(file, "{line}");
            }
        }
        entry
    }
    fn rotate(&self) {
        let oldest = self
            .directory
            .join(format!("heartopia-photo.log.{KEEP_FILES}"));
        let _ = fs::remove_file(oldest);
        for index in (1..KEEP_FILES).rev() {
            let from = self.directory.join(format!("heartopia-photo.log.{index}"));
            let to = self
                .directory
                .join(format!("heartopia-photo.log.{}", index + 1));
            if from.exists() {
                let _ = fs::rename(from, to);
            }
        }
        let _ = fs::rename(
            self.directory.join("heartopia-photo.log"),
            self.directory.join("heartopia-photo.log.1"),
        );
    }
    pub fn entries(&self) -> Vec<LogEntry> {
        self.entries.lock().iter().cloned().collect()
    }
    pub fn export_bytes(&self) -> Result<Vec<u8>, &'static str> {
        let _guard = self.write_lock.lock();
        let mut bytes = Vec::new();
        for index in (0..=KEEP_FILES).rev() {
            let name = if index == 0 {
                "heartopia-photo.log".to_owned()
            } else {
                format!("heartopia-photo.log.{index}")
            };
            if let Ok(mut file) = fs::File::open(self.directory.join(name)) {
                file.read_to_end(&mut bytes).map_err(|_| "无法读取日志")?;
            }
        }
        Ok(bytes)
    }
}

pub fn sanitize(message: &str) -> String {
    // Reject any unexpectedly passed absolute path/URI/credential-looking line entirely.
    let lower = message.to_ascii_lowercase();
    if message.contains(":\\")
        || message.contains(":/")
        || message.contains("\\\\")
        || lower.contains("/users/")
        || lower.contains("\\users\\")
        || lower.contains("token=")
        || lower.contains("password=")
        || lower.contains("key=")
        || lower.contains("iv=")
        || lower.contains("-----begin")
    {
        return "敏感诊断信息已隐藏".into();
    }
    message
        .chars()
        .filter(|c| !c.is_control())
        .take(500)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_paths_and_credentials_are_never_written_or_exported() {
        let dir = tempfile::tempdir().unwrap();
        let logger = SafeLogger::new(dir.path().to_path_buf());
        for text in [
            r"C:\Users\PRIVATE_TEST_USER\secret.png",
            "token=PRIVATE_CREDENTIAL",
            "key=PRIVATE_KEY",
        ] {
            logger.add("error", text);
        }
        let output = String::from_utf8(logger.export_bytes().unwrap()).unwrap();
        assert!(!output.contains("PRIVATE_"));
        assert!(output.contains("敏感诊断信息已隐藏"));
    }
    #[test]
    fn logs_rotate_and_gui_ring_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let logger = SafeLogger::new(dir.path().to_path_buf());
        fs::write(
            dir.path().join("heartopia-photo.log"),
            vec![b'x'; MAX_LOG_BYTES as usize],
        )
        .unwrap();
        for i in 0..550 {
            logger.add("info", &format!("扫描记录 {i}"));
        }
        assert_eq!(logger.entries().len(), UI_LOG_LIMIT);
        assert!(dir.path().join("heartopia-photo.log.1").exists());
    }

    #[test]
    fn restart_restores_recent_logs_and_redacts_untrusted_history() {
        let dir = tempfile::tempdir().unwrap();
        let logger = SafeLogger::new(dir.path().to_path_buf());
        logger.add("info", "批量解密完成：成功 2，失败 0。");
        drop(logger);
        let history = SafeLogger::new(dir.path().to_path_buf());
        assert_eq!(history.entries().len(), 1);
        assert!(history.entries()[0].message.contains("成功 2"));
    }
}
