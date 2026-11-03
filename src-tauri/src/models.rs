use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Filters {
    pub directory: String,
    pub extension: String,
    pub start_date: String,
    pub end_date: String,
    pub query: String,
    pub date_preset: String,
}

impl Default for Filters {
    fn default() -> Self {
        Self {
            directory: String::new(),
            extension: String::new(),
            start_date: String::new(),
            end_date: String::new(),
            query: String::new(),
            date_preset: "all".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryView {
    pub token: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppView {
    pub version: String,
    pub input: Option<DirectoryView>,
    pub output: Option<DirectoryView>,
    pub recent_inputs: Vec<DirectoryView>,
    pub recent_outputs: Vec<DirectoryView>,
    pub filters: Filters,
    pub conflict_policy: String,
    pub workers: u8,
    pub auto_check_updates: bool,
    pub key_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoView {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub directory: String,
    pub size: u64,
    pub extension: String,
    pub date: String,
    pub timestamp_ms: i64,
    pub date_source: String,
    pub status: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: String,
    pub scanned: u64,
    pub found: u64,
    pub errors: u64,
    pub complete: bool,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub job_id: String,
    pub total: usize,
    pub completed: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub done: bool,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    pub status: String,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl UpdateView {
    pub fn new(status: &str, current: String) -> Self {
        Self {
            status: status.into(),
            current_version: current,
            version: None,
            notes: None,
            downloaded: 0,
            total: None,
            message: None,
        }
    }
}
