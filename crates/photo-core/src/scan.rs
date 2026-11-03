//! Read-only recursive scan of a ScreenCapture tree.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

use chrono::{Local, TimeZone};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::date::{now_unix_ms, resolve_timestamp, DateSource};

pub const SUPPORTED_EXTENSIONS: [&str; 3] = ["jpg", "jpeg", "png"];
pub const KNOWN_CAPTURE_DIRS: [&str; 5] = ["Photo", "Limit", "Draw", "NoBgPhoto", "Announcement"];
const MAX_DEPTH: usize = 64;
const TICK_EVERY: u64 = 250;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoRecord {
    /// Stable opaque id derived from the relative path (never an absolute path).
    pub id: String,
    pub name: String,
    /// Path relative to the selected input root, using `\` separators.
    pub relative_path: String,
    /// Relative parent directory (`""` at the root).
    pub directory: String,
    pub size: u64,
    /// Source modification time in Unix milliseconds (used for TOCTOU checks).
    pub modified_ms: i64,
    /// Lower-case extension without a dot.
    pub extension: String,
    /// Local calendar date `YYYY-MM-DD`.
    pub date: String,
    pub timestamp_ms: i64,
    pub date_source: DateSource,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanTick {
    pub scanned: u64,
    pub found: u64,
    pub errors: u64,
    pub complete: bool,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ScanRequest<'a> {
    pub input_root: &'a Path,
    pub now_ms: i64,
    pub cancel: Arc<AtomicBool>,
}

impl<'a> ScanRequest<'a> {
    pub fn new(input_root: &'a Path) -> Self {
        Self {
            input_root,
            now_ms: now_unix_ms(),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Debug)]
pub struct ScanResult {
    pub canonical_root: PathBuf,
    /// Sub-directory to mirror below the output root (`Photo`, `Draw`, ...).
    pub output_prefix: String,
    pub root_name: String,
    pub records: Vec<PhotoRecord>,
    pub scanned: u64,
    pub errors: u64,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("input directory is missing")]
    InputMissing,
    #[error("input path is not a directory")]
    InputNotDirectory,
    #[error("input directory cannot be resolved: {0}")]
    Io(#[from] std::io::Error),
}

struct Ctx<'a> {
    records: Vec<PhotoRecord>,
    errors: u64,
    scanned: u64,
    cancel: Arc<AtomicBool>,
    now_ms: i64,
    started: Instant,
    since_tick: u64,
    cancelled: bool,
    on_tick: &'a mut dyn FnMut(ScanTick),
}

impl Ctx<'_> {
    fn emit(&mut self, complete: bool) {
        let tick = ScanTick {
            scanned: self.scanned,
            found: self.records.len() as u64,
            errors: self.errors,
            complete,
            cancelled: self.cancelled,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        };
        (self.on_tick)(tick);
    }
}

/// Scan `input_root` recursively. Symlinks, junctions and other reparse points
/// are skipped so a scan can never walk outside the selected tree.
pub fn scan(
    request: &ScanRequest<'_>,
    on_tick: &mut dyn FnMut(ScanTick),
) -> Result<ScanResult, ScanError> {
    let meta = fs::metadata(request.input_root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ScanError::InputMissing,
        _ => ScanError::Io(e),
    })?;
    if !meta.is_dir() {
        return Err(ScanError::InputNotDirectory);
    }
    let canonical_root = fs::canonicalize(request.input_root)?;
    let output_prefix = compute_output_prefix(&canonical_root);
    let root_name = canonical_root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical_root.to_string_lossy().into_owned());

    let started = Instant::now();
    let mut ctx = Ctx {
        records: Vec::new(),
        errors: 0,
        scanned: 0,
        cancel: request.cancel.clone(),
        now_ms: request.now_ms,
        started,
        since_tick: 0,
        cancelled: false,
        on_tick,
    };

    walk(&mut ctx, &canonical_root, Path::new(""), 0);
    ctx.records.sort_by(|a, b| {
        b.timestamp_ms.cmp(&a.timestamp_ms).then_with(|| {
            a.relative_path
                .to_lowercase()
                .cmp(&b.relative_path.to_lowercase())
        })
    });
    ctx.emit(true);

    Ok(ScanResult {
        canonical_root,
        output_prefix,
        root_name,
        records: ctx.records,
        scanned: ctx.scanned,
        errors: ctx.errors,
        cancelled: ctx.cancelled,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn walk(ctx: &mut Ctx<'_>, dir: &Path, rel: &Path, depth: usize) {
    if depth > MAX_DEPTH {
        ctx.errors += 1;
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            ctx.errors += 1;
            return;
        }
    };
    for entry in entries {
        if ctx.cancel.load(Ordering::Relaxed) {
            ctx.cancelled = true;
            return;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                ctx.errors += 1;
                continue;
            }
        };
        ctx.scanned += 1;
        ctx.since_tick += 1;
        if ctx.since_tick >= TICK_EVERY {
            ctx.since_tick = 0;
            ctx.emit(false);
        }

        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => {
                ctx.errors += 1;
                continue;
            }
        };
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            continue;
        }
        let name = entry.file_name();
        let child_rel = rel.join(&name);
        if meta.is_dir() {
            walk(ctx, &path, &child_rel, depth + 1);
            if ctx.cancelled {
                return;
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Some(extension) = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
        else {
            continue;
        };
        if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }
        let name_text = name.to_string_lossy().into_owned();
        let modified_ms = modified_ms(&meta);
        let (timestamp_ms, date_source) = resolve_timestamp(&name_text, modified_ms, ctx.now_ms);
        let relative_path = display_relative(&child_rel);
        let directory = child_rel.parent().map(display_relative).unwrap_or_default();
        ctx.records.push(PhotoRecord {
            id: stable_id(&relative_path),
            name: name_text,
            relative_path,
            directory,
            size: meta.len(),
            modified_ms,
            extension,
            date: local_date(timestamp_ms),
            timestamp_ms,
            date_source,
        });
    }
}

pub fn local_date(timestamp_ms: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "1970-01-01".to_string())
}

pub(crate) fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn stable_id(relative_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_path.to_lowercase().as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn display_relative(path: &Path) -> String {
    let mut parts = Vec::new();
    for component in path.components() {
        if let Component::Normal(value) = component {
            parts.push(value.to_string_lossy().into_owned());
        }
    }
    parts.join("\\")
}

fn compute_output_prefix(root: &Path) -> String {
    let mut cursor = Some(root);
    while let Some(dir) = cursor {
        if let Some(name) = dir.file_name() {
            if name.to_string_lossy().eq_ignore_ascii_case("ScreenCapture") {
                return root
                    .strip_prefix(dir)
                    .map(display_relative)
                    .unwrap_or_default();
            }
        }
        cursor = dir.parent();
    }
    if let Some(name) = root.file_name() {
        let text = name.to_string_lossy();
        if KNOWN_CAPTURE_DIRS
            .iter()
            .any(|known| known.eq_ignore_ascii_case(&text))
        {
            return text.to_string();
        }
    }
    String::new()
}

#[cfg(windows)]
pub(crate) fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub(crate) fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::date::FILETIME_UNIX_EPOCH_100NS;
    use std::io::Write;

    fn ft(ms: i64) -> u64 {
        FILETIME_UNIX_EPOCH_100NS + (ms as u64) * 10_000
    }

    fn write_file(path: &Path, len: usize) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(path).unwrap();
        file.write_all(&vec![0xAB; len]).unwrap();
    }

    #[test]
    fn scans_nested_tree_and_marks_sources() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("ScreenCapture");
        let ms = 1_750_433_185_190i64;
        write_file(&root.join("Photo").join(format!("{}.jpg", ft(ms))), 32);
        write_file(&root.join("Photo").join("whole.png"), 32);
        write_file(
            &root.join("Draw").join(format!("{}.PNG", ft(ms + 60_000))),
            32,
        );
        write_file(&root.join("Draw").join("notes.txt"), 8);
        fs::create_dir_all(root.join("Limit")).unwrap();

        let request = ScanRequest {
            input_root: &root,
            now_ms: ms + 86_400_000,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let mut ticks = Vec::new();
        let result = scan(&request, &mut |tick| ticks.push(tick)).unwrap();

        assert_eq!(result.records.len(), 3);
        // 3 directories at the root, 2 files in Photo, 2 files in Draw.
        assert_eq!(result.scanned, 7);
        assert_eq!(result.output_prefix, "");
        assert!(ticks.last().unwrap().complete);
        let whole = result
            .records
            .iter()
            .find(|r| r.name == "whole.png")
            .unwrap();
        assert_eq!(whole.date_source, DateSource::Modified);
        let dated = result
            .records
            .iter()
            .find(|r| r.extension == "png" && r.name != "whole.png")
            .unwrap();
        assert_eq!(dated.date_source, DateSource::Filetime);
        assert_eq!(dated.relative_path, format!("Draw\\{}", dated.name));
        // Newest first.
        assert!(result.records[0].timestamp_ms >= result.records[1].timestamp_ms);
    }

    #[test]
    fn mirrors_known_subdirectory_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let photo = temp.path().join("ScreenCapture").join("Photo");
        fs::create_dir_all(&photo).unwrap();
        write_file(&photo.join("x.jpg"), 32);
        let request = ScanRequest::new(&photo);
        let result = scan(&request, &mut |_| {}).unwrap();
        assert_eq!(result.output_prefix, "Photo");
        assert_eq!(result.records[0].relative_path, "x.jpg");
        assert_eq!(result.root_name, "Photo");
    }

    #[test]
    fn unknown_directory_does_not_gain_a_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("my-photos");
        fs::create_dir_all(&dir).unwrap();
        write_file(&dir.join("a.png"), 16);
        let result = scan(&ScanRequest::new(&dir), &mut |_| {}).unwrap();
        assert_eq!(result.output_prefix, "");
    }

    #[test]
    fn cancellation_stops_early() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("ScreenCapture").join("Photo");
        for index in 0..300 {
            write_file(&root.join(format!("{index}.jpg")), 16);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let request = ScanRequest {
            input_root: &root,
            now_ms: crate::date::now_unix_ms(),
            cancel: cancel.clone(),
        };
        let result = scan(&request, &mut |_| {
            cancel.store(true, Ordering::Relaxed);
        })
        .unwrap();
        assert!(result.cancelled);
        assert!(result.records.len() < 300);
    }

    #[test]
    fn missing_root_is_reported() {
        let request = ScanRequest::new(Path::new("Z:\\definitely-not-here"));
        assert!(matches!(
            scan(&request, &mut |_| {}),
            Err(ScanError::InputMissing) | Err(ScanError::Io(_))
        ));
    }

    #[test]
    fn handles_unicode_and_long_paths() {
        let temp = tempfile::tempdir().unwrap();
        let mut dir = temp.path().join("ScreenCapture").join("Photo");
        for index in 0..10 {
            dir.push(format!("目录片段-{index}-{}", "x".repeat(24)));
        }
        fs::create_dir_all(&dir).unwrap();
        write_file(&dir.join("截图_测试文件.png"), 32);
        let result = scan(
            &ScanRequest::new(&temp.path().join("ScreenCapture")),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(result.records.len(), 1);
        assert!(result.records[0].relative_path.chars().count() > 260);
        assert_eq!(result.records[0].name, "截图_测试文件.png");
    }

    #[cfg(windows)]
    #[test]
    fn skips_junctions() {
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("ScreenCapture").join("Photo");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        write_file(&outside.join("secret.jpg"), 16);
        let junction = root.join("junction");
        let status = Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &junction.to_string_lossy(),
                &outside.to_string_lossy(),
            ])
            .status()
            .expect("cmd available");
        if !status.success() {
            eprintln!("junction creation unavailable on this host; skipping");
            return;
        }
        write_file(&root.join("real.jpg"), 16);
        let result = scan(&ScanRequest::new(&root), &mut |_| {}).unwrap();
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].name, "real.jpg");
    }
}
