//! Bounded, cancellable batch decryption.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::crypto::{CryptoError, CryptoMaterial, DEFAULT_MAX_PLAIN_BYTES, MAX_PLAIN_BYTES};
use crate::output::{
    validate_relative_path, ConflictPolicy, OutputError, PreparedOutput, WriteOutcome,
};
use crate::scan::PhotoRecord;

pub const MAX_WORKERS: usize = 8;
pub const DEFAULT_MAX_CIPHER_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Success,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOutcome {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub status: FileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_relative_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_sha256: Option<String>,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub renamed: bool,
}

impl FileOutcome {
    fn failed(record: &PhotoRecord, reason: &str, bytes_in: u64) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            relative_path: record.relative_path.clone(),
            status: FileStatus::Failed,
            output_relative_path: None,
            reason: Some(reason.to_string()),
            source_sha256: None,
            bytes_in,
            bytes_out: 0,
            renamed: false,
        }
    }

    fn cancelled(record: &PhotoRecord) -> Self {
        Self::cancelled_with(record, 0)
    }

    fn cancelled_with(record: &PhotoRecord, bytes_in: u64) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            relative_path: record.relative_path.clone(),
            status: FileStatus::Cancelled,
            output_relative_path: None,
            reason: Some("cancelled".to_string()),
            source_sha256: None,
            bytes_in,
            bytes_out: 0,
            renamed: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SourceError {
    #[error("source path is invalid")]
    InvalidPath,
    #[error("source file is missing")]
    Missing,
    #[error("source is a reparse point")]
    Reparse,
    #[error("source is not a regular file")]
    NotFile,
    #[error("source changed since the scan")]
    Changed,
    #[error("source exceeds the size limit")]
    TooLarge,
    #[error("source cannot be read")]
    Unreadable,
    #[error("source resolves outside the input root")]
    Alias,
}

impl SourceError {
    /// Stable code for logs/CSV; never contains a path.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidPath => "source_invalid_path",
            Self::Missing => "source_missing",
            Self::Reparse => "source_reparse",
            Self::NotFile => "source_not_file",
            Self::Changed => "source_changed",
            Self::TooLarge => "source_too_large",
            Self::Unreadable => "source_unreadable",
            Self::Alias => "source_alias",
        }
    }
}

/// Read one ciphertext snapshot for a record with the same invariants the
/// batch runner uses. Thumbnail/preview callers should reuse this instead of
/// re-implementing path, reparse, snapshot and handle-alias checks.
pub fn read_snapshot(
    record: &PhotoRecord,
    canonical_input: &Path,
    max_bytes: u64,
) -> Result<Vec<u8>, SourceError> {
    if !canonical_input.is_absolute() {
        return Err(SourceError::InvalidPath);
    }
    let relative = Path::new(&record.relative_path);
    validate_relative_path(relative).map_err(|_| SourceError::InvalidPath)?;
    let source = canonical_input.join(relative);
    let metadata = std::fs::symlink_metadata(&source).map_err(|_| SourceError::Missing)?;
    if metadata.file_type().is_symlink() || crate::scan::is_reparse_point(&metadata) {
        return Err(SourceError::Reparse);
    }
    if !metadata.is_file() {
        return Err(SourceError::NotFile);
    }
    if metadata.len() != record.size || crate::scan::modified_ms(&metadata) != record.modified_ms {
        return Err(SourceError::Changed);
    }
    if record.size > max_bytes {
        return Err(SourceError::TooLarge);
    }
    let capacity = usize::try_from(record.size).map_err(|_| SourceError::TooLarge)?;
    let file = File::open(&source).map_err(|_| SourceError::Unreadable)?;
    let handle_metadata = file.metadata().map_err(|_| SourceError::Unreadable)?;
    if !handle_metadata.is_file()
        || handle_metadata.len() != record.size
        || crate::scan::modified_ms(&handle_metadata) != record.modified_ms
    {
        return Err(SourceError::Changed);
    }
    let final_path =
        crate::platform::final_path_of(&file, &source).map_err(|_| SourceError::Unreadable)?;
    if !crate::output::is_within_ci(&final_path, canonical_input) {
        return Err(SourceError::Alias);
    }
    let mut buffer = Vec::with_capacity(capacity.saturating_add(1));
    file.take(record.size.saturating_add(1))
        .read_to_end(&mut buffer)
        .map_err(|_| SourceError::Unreadable)?;
    if buffer.len() as u64 != record.size {
        return Err(SourceError::Changed);
    }
    Ok(buffer)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTick {
    pub completed: u64,
    pub total: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub skipped: u64,
    pub cancelled: bool,
    pub done: bool,
    pub elapsed_ms: u64,
    /// Id of the file that just finished (`None` on the final tick).
    pub current_id: Option<String>,
    pub current_status: Option<FileStatus>,
    /// Stable failure/skip reason for the file above (`None` on success/final).
    pub reason: Option<String>,
}

#[derive(Debug)]
struct TickEvent {
    id: String,
    status: FileStatus,
    reason: Option<String>,
}

#[derive(Debug)]
pub struct BatchResult {
    pub outcomes: Vec<FileOutcome>,
    pub succeeded: u64,
    pub failed: u64,
    pub skipped: u64,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum BatchError {
    #[error("input root does not match the prepared output boundary")]
    MismatchedRoot,
    #[error("input root cannot be resolved: {0}")]
    Io(#[from] std::io::Error),
}

pub struct BatchRequest<'a> {
    pub records: &'a [PhotoRecord],
    pub input_root: &'a Path,
    pub output: &'a PreparedOutput,
    pub material: &'a CryptoMaterial,
    pub conflict: ConflictPolicy,
    pub workers: usize,
    pub cancel: Arc<AtomicBool>,
    pub max_cipher_bytes: u64,
    pub max_plain_bytes: usize,
}

impl<'a> BatchRequest<'a> {
    pub fn new(
        records: &'a [PhotoRecord],
        input_root: &'a Path,
        output: &'a PreparedOutput,
        material: &'a CryptoMaterial,
    ) -> Self {
        Self {
            records,
            input_root,
            output,
            material,
            conflict: ConflictPolicy::Skip,
            workers: 4,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        }
    }

    /// Caller-provided limits clamped to a hard 32 MiB plaintext ceiling.
    pub fn effective_limits(&self) -> (u64, usize) {
        let plain = self.max_plain_bytes.min(MAX_PLAIN_BYTES);
        let cipher = self.max_cipher_bytes.min(plain as u64 + 16);
        (cipher, plain)
    }
}

/// Decrypt an immutable snapshot of records with bounded parallelism.
///
/// A single failure never aborts the batch, cancellation is cooperative and a
/// partially written file can never appear in the output directory.
pub fn run_batch<F>(request: BatchRequest<'_>, mut on_tick: F) -> Result<BatchResult, BatchError>
where
    F: FnMut(BatchTick),
{
    let canonical_input = std::fs::canonicalize(request.input_root)?;
    if canonical_input != request.output.input_root() {
        return Err(BatchError::MismatchedRoot);
    }

    let total = request.records.len();
    let started = Instant::now();
    let workers = request.workers.clamp(1, MAX_WORKERS).min(total.max(1));
    let next = AtomicUsize::new(0);
    let completed = AtomicU64::new(0);
    let succeeded = AtomicU64::new(0);
    let failed = AtomicU64::new(0);
    let skipped = AtomicU64::new(0);
    let outcomes: Mutex<Vec<Option<FileOutcome>>> = Mutex::new((0..total).map(|_| None).collect());

    let request = &request;
    let next_ref = &next;
    let completed_ref = &completed;
    let succeeded_ref = &succeeded;
    let failed_ref = &failed;
    let skipped_ref = &skipped;
    let outcomes_ref = &outcomes;
    let canonical_input_ref = &canonical_input;

    std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel::<TickEvent>();
        for _ in 0..workers {
            let sender = sender.clone();
            scope.spawn(move || loop {
                let index = next_ref.fetch_add(1, Ordering::Relaxed);
                if index >= total {
                    break;
                }
                let record = &request.records[index];
                let outcome = if request.cancel.load(Ordering::Relaxed) {
                    FileOutcome::cancelled(record)
                } else {
                    process_one(request, record, canonical_input_ref)
                };
                let status = outcome.status;
                let event = TickEvent {
                    id: outcome.id.clone(),
                    status,
                    reason: outcome.reason.clone(),
                };
                match status {
                    FileStatus::Success => {
                        succeeded_ref.fetch_add(1, Ordering::Relaxed);
                    }
                    FileStatus::Failed => {
                        failed_ref.fetch_add(1, Ordering::Relaxed);
                    }
                    FileStatus::Skipped => {
                        skipped_ref.fetch_add(1, Ordering::Relaxed);
                    }
                    FileStatus::Cancelled => {}
                }
                completed_ref.fetch_add(1, Ordering::Relaxed);
                {
                    let mut guard = outcomes_ref
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    guard[index] = Some(outcome);
                }
                let _ = sender.send(event);
            });
        }
        drop(sender);
        for event in receiver {
            on_tick(snapshot_tick(
                completed_ref,
                succeeded_ref,
                failed_ref,
                skipped_ref,
                &request.cancel,
                total as u64,
                started,
                false,
                Some(event),
            ));
        }
    });
    // Emitted after every worker joined: `done` is never observed early.
    on_tick(snapshot_tick(
        completed_ref,
        succeeded_ref,
        failed_ref,
        skipped_ref,
        &request.cancel,
        total as u64,
        started,
        true,
        None,
    ));

    let final_outcomes = outcomes
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .into_iter()
        .map(|item| {
            item.unwrap_or_else(|| FileOutcome {
                id: String::new(),
                name: String::new(),
                relative_path: String::new(),
                status: FileStatus::Cancelled,
                output_relative_path: None,
                reason: Some("cancelled".to_string()),
                source_sha256: None,
                bytes_in: 0,
                bytes_out: 0,
                renamed: false,
            })
        })
        .collect::<Vec<_>>();

    let cancelled = final_outcomes
        .iter()
        .any(|outcome| outcome.status == FileStatus::Cancelled);
    Ok(BatchResult {
        outcomes: final_outcomes,
        succeeded: succeeded.load(Ordering::Relaxed),
        failed: failed.load(Ordering::Relaxed),
        skipped: skipped.load(Ordering::Relaxed),
        cancelled,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[allow(clippy::too_many_arguments)]
fn snapshot_tick(
    completed: &AtomicU64,
    succeeded: &AtomicU64,
    failed: &AtomicU64,
    skipped: &AtomicU64,
    cancel: &AtomicBool,
    total: u64,
    started: Instant,
    done: bool,
    event: Option<TickEvent>,
) -> BatchTick {
    let (current_id, current_status, reason) = match event {
        Some(event) => (Some(event.id), Some(event.status), event.reason),
        None => (None, None, None),
    };
    BatchTick {
        completed: completed.load(Ordering::Relaxed),
        total,
        succeeded: succeeded.load(Ordering::Relaxed),
        failed: failed.load(Ordering::Relaxed),
        skipped: skipped.load(Ordering::Relaxed),
        cancelled: cancel.load(Ordering::Relaxed),
        done,
        elapsed_ms: started.elapsed().as_millis() as u64,
        current_id,
        current_status,
        reason,
    }
}

fn process_one(
    request: &BatchRequest<'_>,
    record: &PhotoRecord,
    canonical_input: &Path,
) -> FileOutcome {
    let (max_cipher, max_plain) = request.effective_limits();
    let ciphertext = match read_snapshot(record, canonical_input, max_cipher) {
        Ok(ciphertext) => ciphertext,
        Err(error) => {
            let bytes_in = if error == SourceError::TooLarge {
                record.size
            } else {
                0
            };
            return FileOutcome::failed(record, error.code(), bytes_in);
        }
    };
    let length = ciphertext.len() as u64;
    if length == 0 {
        return FileOutcome::failed(record, "source_empty", 0);
    }
    if length % 16 != 0 {
        return FileOutcome::failed(record, "source_not_block_aligned", length);
    }
    if request.cancel.load(Ordering::Relaxed) {
        return FileOutcome::cancelled_with(record, length);
    }
    let source_sha256 = sha256_hex(&ciphertext);
    let plaintext = match request.material.decrypt(&ciphertext, max_plain) {
        Ok(plaintext) => plaintext,
        Err(CryptoError::BadPadding) => {
            return FileOutcome::failed(record, "decrypt_padding", length)
        }
        Err(CryptoError::TooLarge) => {
            return FileOutcome::failed(record, "decrypt_too_large", length)
        }
        Err(CryptoError::NotBlockAligned) => {
            return FileOutcome::failed(record, "source_not_block_aligned", length)
        }
        Err(CryptoError::Empty) => return FileOutcome::failed(record, "source_empty", length),
        Err(CryptoError::BadMaterialLength) => {
            return FileOutcome::failed(record, "internal_material", length)
        }
    };
    if request.cancel.load(Ordering::Relaxed) {
        return FileOutcome::cancelled_with(record, length);
    }
    let format = match crate::image_check::decode_verified(&plaintext) {
        Ok(format) => format,
        Err(_) => return FileOutcome::failed(record, "not_image", length),
    };
    let mut output_relative = PathBuf::from(&record.relative_path);
    output_relative.set_extension(format.extension());
    match request.output.write_cancellable(
        &output_relative,
        &plaintext,
        request.conflict,
        &request.cancel,
    ) {
        Ok(WriteOutcome::Written {
            relative_path,
            renamed,
        }) => FileOutcome {
            id: record.id.clone(),
            name: record.name.clone(),
            relative_path: record.relative_path.clone(),
            status: FileStatus::Success,
            output_relative_path: Some(relative_path),
            reason: None,
            source_sha256: Some(source_sha256),
            bytes_in: length,
            bytes_out: plaintext.len() as u64,
            renamed,
        },
        Ok(WriteOutcome::Skipped) => FileOutcome {
            id: record.id.clone(),
            name: record.name.clone(),
            relative_path: record.relative_path.clone(),
            status: FileStatus::Skipped,
            output_relative_path: None,
            reason: Some("output_exists".to_string()),
            source_sha256: Some(source_sha256),
            bytes_in: length,
            bytes_out: 0,
            renamed: false,
        },
        Ok(WriteOutcome::Cancelled) => FileOutcome::cancelled_with(record, length),
        Err(OutputError::OutputInsideInput)
        | Err(OutputError::OutputInsideGameTree)
        | Err(OutputError::UnsafeRelativePath)
        | Err(OutputError::ProtectedOutput) => FileOutcome::failed(record, "output_unsafe", length),
        Err(OutputError::OutputReparse) => FileOutcome::failed(record, "output_reparse", length),
        Err(_) => FileOutcome::failed(record, "output_write_failed", length),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::ensure_output_allowed;
    use crate::scan::{scan, ScanRequest};
    use std::fs;

    fn material() -> CryptoMaterial {
        CryptoMaterial::new([7u8; 32], [9u8; 16])
    }

    fn tiny_png() -> Vec<u8> {
        let image = image::RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }

    fn tiny_jpeg() -> Vec<u8> {
        let image = image::RgbImage::from_pixel(4, 3, image::Rgb([90, 40, 10]));
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        jpeg
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        input: PathBuf,
        output: PathBuf,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("ScreenCapture").join("Draw");
        fs::create_dir_all(&input).unwrap();
        let output = temp.path().join("decrypted");
        Fixture {
            _temp: temp,
            input,
            output,
        }
    }

    fn add_encrypted(fixture: &Fixture, name: &str, plaintext: &[u8]) -> PathBuf {
        let cipher = material().encrypt(plaintext).unwrap();
        let path = fixture.input.join(name);
        fs::write(&path, cipher).unwrap();
        path
    }

    fn records(fixture: &Fixture) -> Vec<PhotoRecord> {
        scan(&ScanRequest::new(&fixture.input), &mut |_| {})
            .unwrap()
            .records
    }

    #[test]
    fn batch_decrypts_and_skips_bad_files() {
        let fixture = fixture();
        let png = tiny_png();
        let good = add_encrypted(&fixture, "good.png", &png);
        let bad = fixture.input.join("bad.png");
        fs::write(&bad, vec![0u8; 32]).unwrap();
        let records = records(&fixture);
        assert_eq!(records.len(), 2);
        let output = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        let material = material();
        let request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &output,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 2,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let mut ticks = Vec::new();
        let result = run_batch(request, |tick| ticks.push(tick)).unwrap();
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.failed, 1);
        assert!(!result.cancelled);
        assert!(ticks.last().unwrap().done);

        let written = fixture.output.join("Draw").join("good.png");
        assert_eq!(fs::read(&written).unwrap(), png);
        let original = fs::read(&good).unwrap();
        assert_ne!(original, png);
        let failure = result
            .outcomes
            .iter()
            .find(|o| o.relative_path == "bad.png")
            .unwrap();
        assert_eq!(failure.reason.as_deref(), Some("decrypt_padding"));
    }

    #[test]
    fn collision_is_skipped_then_renamed_without_touching_source() {
        let fixture = fixture();
        let png = tiny_png();
        add_encrypted(&fixture, "shot.png", &png);
        let records = records(&fixture);
        let prepared = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        fs::write(fixture.output.join("Draw").join("shot.png"), b"keep me").unwrap();
        let material = material();

        let skip_request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 1,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let skipped = run_batch(skip_request, |_| {}).unwrap();
        assert_eq!(skipped.skipped, 1);
        assert_eq!(
            fs::read(fixture.output.join("Draw").join("shot.png")).unwrap(),
            b"keep me"
        );

        let rename_request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Rename,
            workers: 1,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let renamed = run_batch(rename_request, |_| {}).unwrap();
        assert_eq!(renamed.succeeded, 1);
        assert_eq!(
            renamed.outcomes[0].output_relative_path.as_deref(),
            Some("Draw\\shot (1).png")
        );
        assert_eq!(
            fs::read(fixture.output.join("Draw").join("shot.png")).unwrap(),
            b"keep me"
        );
        assert_eq!(
            fs::read(fixture.output.join("Draw").join("shot (1).png")).unwrap(),
            png
        );
    }

    #[test]
    fn cancellation_produces_cancelled_outcomes() {
        let fixture = fixture();
        let png = tiny_png();
        for index in 0..40 {
            add_encrypted(&fixture, &format!("f{index:02}.png"), &png);
        }
        let records = records(&fixture);
        let prepared = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        let material = material();
        let cancel = Arc::new(AtomicBool::new(false));
        let request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 1,
            cancel: cancel.clone(),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let result = run_batch(request, |_| cancel.store(true, Ordering::Relaxed)).unwrap();
        assert!(result.cancelled);
        assert!(result
            .outcomes
            .iter()
            .any(|o| o.status == FileStatus::Cancelled));
    }

    #[test]
    fn detects_source_change_between_scan_and_batch() {
        let fixture = fixture();
        let png = tiny_png();
        add_encrypted(&fixture, "changed.png", &png);
        let records = records(&fixture);
        let source = fixture.input.join("changed.png");
        let mut content = fs::read(&source).unwrap();
        content.extend_from_slice(&[0u8; 16]);
        fs::write(&source, content).unwrap();

        let prepared = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        let material = material();
        let request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 1,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let result = run_batch(request, |_| {}).unwrap();
        assert_eq!(result.succeeded, 0);
        assert_eq!(result.outcomes[0].reason.as_deref(), Some("source_changed"));
        assert!(!fixture.output.join("Draw").join("changed.png").exists());
    }

    #[test]
    fn ticks_carry_per_file_identity_and_reason() {
        use std::collections::HashSet;
        let fixture = fixture();
        let png = tiny_png();
        add_encrypted(&fixture, "a.png", &png);
        add_encrypted(&fixture, "b.png", &png);
        fs::write(fixture.input.join("bad.png"), vec![0u8; 32]).unwrap();
        let records = records(&fixture);
        let prepared = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        let material = material();
        let request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 1,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let mut ticks = Vec::new();
        run_batch(request, |tick| ticks.push(tick)).unwrap();

        let partial: Vec<_> = ticks.iter().filter(|tick| !tick.done).collect();
        assert_eq!(partial.len(), 3);
        assert_eq!(
            partial
                .iter()
                .map(|tick| tick.completed)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        let ids: HashSet<String> = partial
            .iter()
            .filter_map(|tick| tick.current_id.clone())
            .collect();
        assert_eq!(ids.len(), 3);
        assert!(partial.iter().all(|tick| tick.current_status.is_some()));
        let failed = partial
            .iter()
            .find(|tick| tick.current_status == Some(FileStatus::Failed))
            .expect("a failed file tick");
        assert_eq!(failed.reason.as_deref(), Some("decrypt_padding"));

        let last = ticks.last().unwrap();
        assert!(last.done);
        assert_eq!(last.completed, 3);
        assert!(last.current_id.is_none());
        assert!(last.current_status.is_none());
        assert!(last.reason.is_none());
    }

    #[test]
    fn valid_padding_with_invalid_header_fails_not_image() {
        let fixture = fixture();
        let mut fake = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        fake.extend_from_slice(&[0u8; 64]);
        fake.extend_from_slice(&[0xFF, 0xD9]);
        add_encrypted(&fixture, "fake.jpg", &fake);
        let records = records(&fixture);
        let prepared = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        let material = material();
        let request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 1,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let result = run_batch(request, |_| {}).unwrap();
        assert_eq!(result.failed, 1);
        assert_eq!(result.outcomes[0].reason.as_deref(), Some("not_image"));
        assert!(!fixture.output.join("Draw").join("fake.jpg").exists());
    }

    #[test]
    fn valid_jpeg_is_fully_decoded_and_committed() {
        let fixture = fixture();
        let jpeg = tiny_jpeg();
        add_encrypted(&fixture, "photo.jpg", &jpeg);
        let records = records(&fixture);
        let prepared = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        let material = material();
        let request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 1,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let result = run_batch(request, |_| {}).unwrap();
        assert_eq!(result.succeeded, 1);
        let written = fs::read(fixture.output.join("Draw").join("photo.jpg")).unwrap();
        assert_eq!(written, jpeg);
        let decoded = image::load_from_memory(&written).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (4, 3));
    }

    #[test]
    fn truncated_image_never_commits() {
        let fixture = fixture();
        let png = tiny_png();
        let truncated = png[..png.len() - 12].to_vec();
        add_encrypted(&fixture, "truncated.png", &truncated);
        let records = records(&fixture);
        let prepared = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        let material = material();
        let request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 1,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
            max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
        };
        let result = run_batch(request, |_| {}).unwrap();
        assert_eq!(result.failed, 1);
        assert_eq!(result.outcomes[0].reason.as_deref(), Some("not_image"));
        assert!(!fixture.output.join("Draw").join("truncated.png").exists());
    }

    #[test]
    fn read_snapshot_checks_snapshot_and_limits() {
        let fixture = fixture();
        let png = tiny_png();
        add_encrypted(&fixture, "snapshot.png", &png);
        let records = records(&fixture);
        let canonical = fs::canonicalize(&fixture.input).unwrap();
        let bytes = read_snapshot(&records[0], &canonical, 1 << 20).unwrap();
        assert_eq!(bytes.len() as u64, records[0].size);
        assert_eq!(
            read_snapshot(&records[0], &canonical, 8).unwrap_err(),
            SourceError::TooLarge
        );
        let mut changed = records[0].clone();
        changed.size += 1;
        assert_eq!(
            read_snapshot(&changed, &canonical, 1 << 20).unwrap_err(),
            SourceError::Changed
        );
    }

    #[cfg(windows)]
    #[test]
    fn read_snapshot_rejects_parent_alias() {
        use crate::date::DateSource;
        use std::process::Command;
        let fixture = fixture();
        let outside = fixture._temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let png = tiny_png();
        let cipher = material().encrypt(&png).unwrap();
        fs::write(outside.join("secret.png"), &cipher).unwrap();
        let junction = fixture.input.join("junction");
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
        let link_path = junction.join("secret.png");
        let metadata = fs::metadata(&link_path).unwrap();
        let record = PhotoRecord {
            id: "alias".to_string(),
            name: "secret.png".to_string(),
            relative_path: "junction\\secret.png".to_string(),
            directory: "junction".to_string(),
            size: metadata.len(),
            modified_ms: crate::scan::modified_ms(&metadata),
            extension: "png".to_string(),
            date: "2025-01-01".to_string(),
            timestamp_ms: 0,
            date_source: DateSource::Modified,
        };
        let canonical = fs::canonicalize(&fixture.input).unwrap();
        assert_eq!(
            read_snapshot(&record, &canonical, 1 << 20).unwrap_err(),
            SourceError::Alias
        );
    }

    #[test]
    fn effective_limits_are_clamped() {
        let fixture = fixture();
        let records: Vec<PhotoRecord> = Vec::new();
        let prepared = ensure_output_allowed(&fixture.input, &fixture.output, "Draw").unwrap();
        let material = material();
        let request = BatchRequest {
            records: &records,
            input_root: &fixture.input,
            output: &prepared,
            material: &material,
            conflict: ConflictPolicy::Skip,
            workers: 4,
            cancel: Arc::new(AtomicBool::new(false)),
            max_cipher_bytes: u64::MAX,
            max_plain_bytes: usize::MAX,
        };
        assert_eq!(
            request.effective_limits(),
            (
                crate::crypto::MAX_PLAIN_BYTES as u64 + 16,
                crate::crypto::MAX_PLAIN_BYTES
            )
        );
    }
}
