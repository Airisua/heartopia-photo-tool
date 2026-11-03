//! Native acceptance harness for the Heartopia photo core.
//!
//! This example is intentionally independent of the Tauri UI. It validates the
//! real `ScreenCapture` tree read-only, then exercises synthetic failure and
//! cancellation paths under a caller-provided scratch directory.
//!
//! Security rules:
//! * key material is read only from `HEARTOPIA_CRYPTO_MATERIAL_B64` (base64,
//!   48 bytes) and is never printed;
//! * the real input tree is never written to;
//! * stdout contains exactly one aggregate JSON object;
//! * filesystem errors are reduced to stable codes, never raw paths/debug text.
//!
//! Usage:
//!   acceptance --input <ScreenCapture-or-subdir> --output <empty-output-dir>
//!              --work <fresh-empty-dir-outside-input>

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use heartopia_photo_core::batch::BatchError;
use heartopia_photo_core::{
    capture_root_of, decode_verified, ensure_output_allowed, is_within_ci, read_snapshot,
    run_batch, scan, validate_output_target, BatchRequest, ConflictPolicy, CryptoError,
    CryptoMaterial, DateSource, FileOutcome, FileStatus, OutputError, PhotoRecord, PreparedOutput,
    ScanError, ScanRequest, DEFAULT_MAX_CIPHER_BYTES, DEFAULT_MAX_PLAIN_BYTES,
};
use serde_json::{json, Map, Value};

const CATEGORIES: [&str; 5] = ["Photo", "Limit", "Draw", "NoBgPhoto", "Announcement"];
const MAX_PER_CATEGORY: usize = 3;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const TICK_EVERY: u64 = 250;
const MAX_IMAGE_EDGE: u32 = 16_384;

fn main() {
    let args = match parse_args() {
        Ok(Some(args)) => args,
        Ok(None) => {
            println!(
                "{}",
                json!({
                    "status": "help",
                    "usage": [
                        "--input <ScreenCapture-or-subdir>",
                        "--output <outside-input-output-dir>",
                        "--work <fresh-empty-dir-outside-input>"
                    ],
                    "requiresEnv": "HEARTOPIA_CRYPTO_MATERIAL_B64"
                })
            );
            return;
        }
        Err(code) => {
            println!(
                "{}",
                json!({
                    "status": "error",
                    "error": code,
                    "usage": [
                        "--input <ScreenCapture-or-subdir>",
                        "--output <outside-input-output-dir>",
                        "--work <fresh-empty-dir-outside-input>"
                    ]
                })
            );
            std::process::exit(2);
        }
    };

    let report = run(&args);
    let status = report
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("error")
        .to_string();
    match serde_json::to_string(&report) {
        Ok(text) => println!("{text}"),
        Err(_) => {
            println!("{{\"status\":\"error\",\"error\":\"report_serialization\"}}");
            std::process::exit(1);
        }
    }
    if status != "pass" {
        std::process::exit(1);
    }
}

struct Args {
    input: PathBuf,
    output: PathBuf,
    work: PathBuf,
}

/// `Ok(None)` means `--help`; `Err` carries a stable usage code.
fn parse_args() -> Result<Option<Args>, &'static str> {
    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut work: Option<PathBuf> = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let text = arg.to_string_lossy();
        match text.as_ref() {
            "--help" | "-h" => return Ok(None),
            "--input" => {
                input = Some(PathBuf::from(args.next().ok_or("usage")?));
            }
            "--output" => {
                output = Some(PathBuf::from(args.next().ok_or("usage")?));
            }
            "--work" => {
                work = Some(PathBuf::from(args.next().ok_or("usage")?));
            }
            _ => return Err("usage"),
        }
    }
    let input = input.ok_or("usage")?;
    let output = output.ok_or("usage")?;
    let work = work.unwrap_or_else(|| derive_work_dir(&output));
    Ok(Some(Args {
        input,
        output,
        work,
    }))
}

/// Default scratch location: a sibling of the output directory. The launcher
/// always passes an explicit path under the ignored `.local` tree.
fn derive_work_dir(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "acceptance".to_string());
    output
        .parent()
        .map(|parent| parent.join(format!("{name}.work")))
        .unwrap_or_else(|| PathBuf::from(format!("{name}.work")))
}

#[derive(Default)]
struct Checks {
    failures: Vec<&'static str>,
}

impl Checks {
    fn require(&mut self, condition: bool, code: &'static str) {
        if !condition {
            self.failures.push(code);
        }
    }

    fn fail(&mut self, code: &'static str) {
        self.failures.push(code);
    }
}

fn run(args: &Args) -> Value {
    let work_root = match prepare_work_root(&args.input, &args.work) {
        Ok(path) => path,
        Err(code) => return json!({ "status": "error", "error": code }),
    };
    let material = match load_material() {
        Ok(material) => material,
        Err(code) => return json!({ "status": "error", "error": code }),
    };
    let mut checks = Checks::default();

    let root_before = fs::metadata(&args.input)
        .ok()
        .map(|meta| (meta.len(), modified_ms(&meta)));

    let real_scan = match scan(&ScanRequest::new(&args.input), &mut |_| {}) {
        Ok(result) => result,
        Err(error) => {
            return json!({ "status": "error", "error": scan_error_code(&error) });
        }
    };

    let mut date_filetime = 0usize;
    let mut date_modified = 0usize;
    for record in &real_scan.records {
        match record.date_source {
            DateSource::Filetime => date_filetime += 1,
            DateSource::Modified => date_modified += 1,
        }
    }
    checks.require(!real_scan.records.is_empty(), "scan_no_records");

    // Cancellation during a real scan. The core emits a tick every 250 entries,
    // so tiny inputs cannot exercise the cancel path; mark that explicitly.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let cancel_handle = cancel_flag.clone();
    let mut cancel_request = ScanRequest::new(&args.input);
    cancel_request.cancel = cancel_flag.clone();
    let cancel_result = scan(&cancel_request, &mut |tick| {
        if !tick.complete {
            cancel_handle.store(true, Ordering::Relaxed);
        }
    });
    let scan_exercised = real_scan.scanned > TICK_EVERY;
    let scan_cancelled = match cancel_result {
        Ok(result) => result.cancelled,
        Err(_) => {
            checks.fail("scan_cancel_failed");
            false
        }
    };
    if scan_exercised {
        checks.require(scan_cancelled, "scan_cancel_not_observed");
    }

    // Build a category map and choose a small, deterministic sample.
    let mut by_category: HashMap<&'static str, Vec<usize>> = HashMap::new();
    for (index, record) in real_scan.records.iter().enumerate() {
        if let Some(category) =
            record_category(record, &real_scan.output_prefix, &real_scan.root_name)
        {
            by_category.entry(category).or_default().push(index);
        }
    }
    let mut category_available: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut selected_indices: Vec<usize> = Vec::new();
    for category in CATEGORIES {
        let all = by_category.get(category).cloned().unwrap_or_default();
        category_available.insert(category, all.len());
        let mut usable: Vec<usize> = all
            .into_iter()
            .filter(|&index| {
                let record = &real_scan.records[index];
                record.size > 0 && record.size % 16 == 0
            })
            .collect();
        usable.sort_by(|&left, &right| {
            let left_record = &real_scan.records[left];
            let right_record = &real_scan.records[right];
            preferred_1920(left_record)
                .cmp(&preferred_1920(right_record))
                .then_with(|| {
                    left_record
                        .relative_path
                        .to_lowercase()
                        .cmp(&right_record.relative_path.to_lowercase())
                })
        });
        selected_indices.extend(usable.into_iter().take(MAX_PER_CATEGORY));
    }
    checks.require(!selected_indices.is_empty(), "scan_no_samples");

    let selected_records: Vec<PhotoRecord> = selected_indices
        .iter()
        .map(|&index| real_scan.records[index].clone())
        .collect();

    let prepared = match ensure_output_allowed(
        &real_scan.canonical_root,
        &args.output,
        &real_scan.output_prefix,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            return json!({
                "status": "error",
                "error": output_error_code(&error),
                "scan": {
                    "records": real_scan.records.len(),
                    "entries": real_scan.scanned
                }
            });
        }
    };

    // Snapshot every source before batch processing; compare afterwards.
    let mut before_snapshots: Vec<Option<Vec<u8>>> = Vec::with_capacity(selected_records.len());
    let mut sample_reasons: BTreeMap<String, usize> = BTreeMap::new();
    for record in &selected_records {
        match read_snapshot(record, &real_scan.canonical_root, DEFAULT_MAX_CIPHER_BYTES) {
            Ok(bytes) => before_snapshots.push(Some(bytes)),
            Err(error) => {
                bump(&mut sample_reasons, error.code());
                checks.fail("sample_snapshot_failed");
                before_snapshots.push(None);
            }
        }
    }

    let request = BatchRequest {
        records: &selected_records,
        input_root: &real_scan.canonical_root,
        output: &prepared,
        material: &material,
        conflict: ConflictPolicy::Skip,
        workers: 2,
        cancel: Arc::new(AtomicBool::new(false)),
        max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
        max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
    };
    let batch = match run_batch(request, |_| {}) {
        Ok(result) => result,
        Err(error) => {
            return json!({ "status": "error", "error": batch_error_code(&error) });
        }
    };

    let mut source_unchanged = true;
    for (record, snapshot) in selected_records.iter().zip(before_snapshots.iter()) {
        let source = real_scan.canonical_root.join(&record.relative_path);
        if let Some(expected) = snapshot {
            match fs::read(&source) {
                Ok(actual) => {
                    if actual != *expected {
                        source_unchanged = false;
                        checks.fail("sample_source_changed");
                    }
                }
                Err(_) => {
                    source_unchanged = false;
                    checks.fail("sample_source_unreadable");
                }
            }
        }
        match fs::metadata(&source) {
            Ok(meta) => {
                if meta.len() != record.size || modified_ms(&meta) != record.modified_ms {
                    source_unchanged = false;
                    checks.fail("sample_source_metadata_changed");
                }
            }
            Err(_) => {
                source_unchanged = false;
                checks.fail("sample_source_missing");
            }
        }
    }

    let mut decoded = 0usize;
    let mut dimension_counts: BTreeMap<(u32, u32), usize> = BTreeMap::new();
    let mut category_succeeded: BTreeMap<&'static str, usize> = BTreeMap::new();
    for outcome in &batch.outcomes {
        match outcome.status {
            FileStatus::Success => {
                if let Some(record) = selected_records
                    .iter()
                    .find(|record| record.id == outcome.id)
                {
                    if let Some(category) =
                        record_category(record, &real_scan.output_prefix, &real_scan.root_name)
                    {
                        *category_succeeded.entry(category).or_insert(0) += 1;
                    }
                }
                let Some(relative) = outcome.output_relative_path.as_deref() else {
                    checks.fail("sample_output_path_missing");
                    continue;
                };
                let output_path = prepared.root().join(relative);
                let bytes = match fs::read(&output_path) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        checks.fail("sample_output_missing");
                        continue;
                    }
                };
                if let Some(index) = selected_records
                    .iter()
                    .position(|record| record.id == outcome.id)
                {
                    match before_snapshots.get(index) {
                        Some(Some(snapshot)) => {
                            match material.decrypt(snapshot, DEFAULT_MAX_PLAIN_BYTES) {
                                Ok(plaintext) => {
                                    if plaintext.as_slice() != bytes.as_slice() {
                                        checks.fail("sample_output_mismatch");
                                    }
                                }
                                Err(_) => checks.fail("sample_snapshot_decrypt_failed"),
                            }
                        }
                        _ => checks.fail("sample_snapshot_missing"),
                    }
                }
                match decode_verified(&bytes) {
                    Ok(format) => {
                        decoded += 1;
                        let expected = format.extension();
                        let matches = output_path
                            .extension()
                            .and_then(|value| value.to_str())
                            .map(|value| value.eq_ignore_ascii_case(expected))
                            .unwrap_or(false);
                        checks.require(matches, "sample_extension_mismatch");
                    }
                    Err(_) => {
                        checks.fail("sample_output_undecodable");
                        continue;
                    }
                }
                match image_dimensions(&bytes) {
                    Some(dimensions) => {
                        *dimension_counts.entry(dimensions).or_insert(0) += 1;
                    }
                    None => checks.fail("sample_dimension_unparsed"),
                }
            }
            FileStatus::Failed => {
                checks.fail("sample_batch_failed");
                if let Some(reason) = &outcome.reason {
                    bump(&mut sample_reasons, reason);
                }
            }
            FileStatus::Skipped => {
                checks.fail("sample_output_collision");
                if let Some(reason) = &outcome.reason {
                    bump(&mut sample_reasons, reason);
                }
            }
            FileStatus::Cancelled => checks.fail("sample_cancelled"),
        }
    }
    checks.require(
        batch.succeeded as usize == selected_records.len(),
        "sample_batch_incomplete",
    );
    checks.require(
        batch.failed == 0 && batch.skipped == 0 && !batch.cancelled,
        "sample_batch_not_clean",
    );

    let output_temps = count_temp_files(prepared.root());
    checks.require(output_temps == 0, "sample_temp_leftover");

    // Collision policy: skip must not touch the existing file; rename must
    // choose a new name and leave the existing file untouched.
    let mut collisions = json!({
        "skipWorked": false,
        "renameWorked": false,
        "existingPreserved": true
    });
    let collision_sample = batch
        .outcomes
        .iter()
        .find(|outcome| {
            outcome.status == FileStatus::Success && outcome.output_relative_path.is_some()
        })
        .and_then(|outcome| {
            selected_records
                .iter()
                .find(|record| record.id == outcome.id)
                .map(|record| {
                    (
                        record.clone(),
                        outcome.output_relative_path.clone().unwrap(),
                    )
                })
        });
    match collision_sample {
        Some((record, original_relative)) => {
            let original_path = prepared.root().join(&original_relative);
            let original_bytes = match fs::read(&original_path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    checks.fail("collision_existing_missing");
                    Vec::new()
                }
            };

            let skip_request = BatchRequest {
                records: std::slice::from_ref(&record),
                input_root: &real_scan.canonical_root,
                output: &prepared,
                material: &material,
                conflict: ConflictPolicy::Skip,
                workers: 1,
                cancel: Arc::new(AtomicBool::new(false)),
                max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
                max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
            };
            let skip_worked = match run_batch(skip_request, |_| {}) {
                Ok(result) => {
                    result.skipped == 1
                        && result.outcomes.len() == 1
                        && result.outcomes[0].status == FileStatus::Skipped
                }
                Err(_) => {
                    checks.fail("collision_skip_error");
                    false
                }
            };

            let mut existing_preserved = true;
            match fs::read(&original_path) {
                Ok(bytes) => {
                    if bytes != original_bytes {
                        existing_preserved = false;
                    }
                }
                Err(_) => existing_preserved = false,
            }

            let rename_request = BatchRequest {
                records: std::slice::from_ref(&record),
                input_root: &real_scan.canonical_root,
                output: &prepared,
                material: &material,
                conflict: ConflictPolicy::Rename,
                workers: 1,
                cancel: Arc::new(AtomicBool::new(false)),
                max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
                max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
            };
            let rename_worked = match run_batch(rename_request, |_| {}) {
                Ok(result) => {
                    let renamed_out = result
                        .outcomes
                        .first()
                        .and_then(|outcome| outcome.output_relative_path.clone());
                    let renamed = result
                        .outcomes
                        .first()
                        .map(|outcome| outcome.renamed)
                        .unwrap_or(false);
                    let differs = renamed_out.as_deref() != Some(original_relative.as_str());
                    let content_matches = match renamed_out {
                        Some(relative) => match fs::read(prepared.root().join(relative)) {
                            Ok(bytes) => bytes == original_bytes,
                            Err(_) => false,
                        },
                        None => false,
                    };
                    result.succeeded == 1 && renamed && differs && content_matches
                }
                Err(_) => {
                    checks.fail("collision_rename_error");
                    false
                }
            };

            match fs::read(&original_path) {
                Ok(bytes) => {
                    if bytes != original_bytes {
                        existing_preserved = false;
                    }
                }
                Err(_) => existing_preserved = false,
            }

            checks.require(skip_worked, "collision_skip_failed");
            checks.require(rename_worked, "collision_rename_failed");
            checks.require(existing_preserved, "collision_existing_changed");
            collisions = json!({
                "skipWorked": skip_worked,
                "renameWorked": rename_worked,
                "existingPreserved": existing_preserved
            });
        }
        None => checks.fail("collision_no_sample"),
    }
    let collision_temps = count_temp_files(prepared.root());
    checks.require(collision_temps == 0, "collision_temp_leftover");

    // Re-check sources after the collision reruns: every real-tree operation
    // must leave the original ciphertext and metadata untouched.
    for (record, snapshot) in selected_records.iter().zip(before_snapshots.iter()) {
        let source = real_scan.canonical_root.join(&record.relative_path);
        if let Some(expected) = snapshot {
            match fs::read(&source) {
                Ok(actual) => {
                    if actual != *expected {
                        source_unchanged = false;
                        checks.fail("sample_source_changed");
                    }
                }
                Err(_) => {
                    source_unchanged = false;
                    checks.fail("sample_source_unreadable");
                }
            }
        }
        match fs::metadata(&source) {
            Ok(meta) => {
                if meta.len() != record.size || modified_ms(&meta) != record.modified_ms {
                    source_unchanged = false;
                    checks.fail("sample_source_metadata_changed");
                }
            }
            Err(_) => {
                source_unchanged = false;
                checks.fail("sample_source_missing");
            }
        }
    }

    // Synthetic fixture matrix lives entirely under the ignored scratch tree.
    let fixture_paths = match build_fixtures(&work_root, &material) {
        Ok(paths) => Some(paths),
        Err(code) => {
            checks.fail(code);
            None
        }
    };
    let fixture = match fixture_paths.as_ref() {
        Some(paths) => run_fixture_checks(paths, &material, &mut checks),
        None => json!({ "built": false }),
    };
    let cancellation = match fixture_paths.as_ref() {
        Some(paths) => run_cancellation_check(paths, &material, &mut checks),
        None => (false, 0),
    };

    let root_after = fs::metadata(&real_scan.canonical_root)
        .ok()
        .map(|meta| (meta.len(), modified_ms(&meta)));
    let root_unchanged = root_before == root_after;

    let mut category_selected: BTreeMap<&'static str, usize> = BTreeMap::new();
    for record in &selected_records {
        if let Some(category) =
            record_category(record, &real_scan.output_prefix, &real_scan.root_name)
        {
            *category_selected.entry(category).or_insert(0) += 1;
        }
    }
    let mut categories_json = Map::new();
    for category in CATEGORIES {
        let available = category_available.get(category).copied().unwrap_or(0);
        let selected = category_selected.get(category).copied().unwrap_or(0);
        let succeeded = category_succeeded.get(category).copied().unwrap_or(0);
        checks.require(available == 0 || selected > 0, "sample_category_unusable");
        checks.require(
            selected == 0 || succeeded == selected,
            "sample_category_incomplete",
        );
        categories_json.insert(
            category.to_string(),
            json!({
                "available": available,
                "selected": selected,
                "succeeded": succeeded
            }),
        );
    }

    let mut dimension_rows: Vec<((u32, u32), usize)> = dimension_counts.into_iter().collect();
    dimension_rows.sort_by(|left, right| {
        let ((left_width, left_height), _) = *left;
        let ((right_width, right_height), _) = *right;
        right_width
            .cmp(&left_width)
            .then_with(|| right_height.cmp(&left_height))
    });
    let dimensions: Vec<Value> = dimension_rows
        .into_iter()
        .map(|((width, height), count)| json!({ "width": width, "height": height, "count": count }))
        .collect();

    let reasons: Map<String, Value> = sample_reasons
        .into_iter()
        .map(|(reason, count)| (reason, json!(count)))
        .collect();

    checks.failures.sort_unstable();
    checks.failures.dedup();
    let status = if checks.failures.is_empty() {
        "pass"
    } else {
        "fail"
    };

    json!({
        "status": status,
        "scan": {
            "records": real_scan.records.len(),
            "entries": real_scan.scanned,
            "errors": real_scan.errors,
            "dateFiletime": date_filetime,
            "dateModified": date_modified,
            "elapsedMs": real_scan.elapsed_ms,
            "cancelled": scan_cancelled,
            "cancelExercised": scan_exercised,
            "rootUnchanged": root_unchanged
        },
        "samples": {
            "categories": categories_json,
            "selected": selected_records.len(),
            "succeeded": batch.succeeded,
            "failed": batch.failed,
            "skipped": batch.skipped,
            "decoded": decoded,
            "dimensions": dimensions,
            "reasons": reasons
        },
        "batch": {
            "succeeded": batch.succeeded,
            "failed": batch.failed,
            "skipped": batch.skipped,
            "sourceUnchanged": source_unchanged,
            "tempFiles": output_temps,
            "elapsedMs": batch.elapsed_ms
        },
        "collisions": collisions,
        "negative": fixture,
        "cancellation": {
            "scan": scan_cancelled || !scan_exercised,
            "scanExercised": scan_exercised,
            "batch": cancellation.0,
            "tempFiles": cancellation.1
        },
        "unicodeLongPath": fixture.get("unicode").and_then(Value::as_bool).unwrap_or(false)
            && fixture.get("longPath").and_then(Value::as_bool).unwrap_or(false),
        "limitations": [
            "log panel, log export and failure CSV are app commands, not exposed by the core",
            "clean-machine install and updater acceptance are not covered by this harness",
            "real-tree checks depend on locally prepared DPAPI material"
        ],
        "failures": checks.failures
    })
}

fn load_material() -> Result<CryptoMaterial, &'static str> {
    let encoded =
        std::env::var("HEARTOPIA_CRYPTO_MATERIAL_B64").map_err(|_| "crypto_material_missing")?;
    std::env::remove_var("HEARTOPIA_CRYPTO_MATERIAL_B64");
    let mut encoded_bytes = encoded.into_bytes();
    let start = encoded_bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(encoded_bytes.len());
    let end = encoded_bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)
        .unwrap_or(start);
    let mut trimmed = encoded_bytes[start..end].to_vec();
    encoded_bytes.fill(0);
    let mut decoded = match STANDARD.decode(trimmed.as_slice()) {
        Ok(value) => value,
        Err(_) => {
            trimmed.fill(0);
            return Err("crypto_material_invalid");
        }
    };
    trimmed.fill(0);
    if decoded.len() != 48 {
        decoded.fill(0);
        return Err("crypto_material_invalid");
    }
    let mut key = [0u8; 32];
    let mut iv = [0u8; 16];
    key.copy_from_slice(&decoded[..32]);
    iv.copy_from_slice(&decoded[32..]);
    let material = CryptoMaterial::new(key, iv);
    key.fill(0);
    iv.fill(0);
    decoded.fill(0);
    Ok(material)
}

/// Validate and create the synthetic-fixture root before any fixture write.
///
/// The root must be outside the real input and its game tree, must not contain
/// either tree, must not be a reparse point, and must be new or empty. Existing
/// non-empty directories are rejected; nothing is deleted or overwritten.
fn prepare_work_root(input: &Path, work: &Path) -> Result<PathBuf, &'static str> {
    let canonical = validate_output_target(input, work).map_err(|error| work_error_code(&error))?;
    let input_canonical = fs::canonicalize(input).map_err(|_| "input_io")?;

    if capture_root_of(&canonical).is_some() {
        return Err("work_inside_game_tree");
    }

    // `validate_output_target` rejects work inside the input/game tree. Also
    // reject the reverse direction so the synthetic `ScreenCapture` subtree
    // cannot land on top of the real one.
    if is_within_ci(&input_canonical, &canonical) {
        return Err("work_contains_input");
    }
    if let Some(capture_root) = capture_root_of(&input_canonical) {
        if is_within_ci(&capture_root, &canonical) {
            return Err("work_contains_game_tree");
        }
    }

    if canonical.exists() {
        let meta = fs::symlink_metadata(&canonical).map_err(|_| "work_unreadable")?;
        if !meta.is_dir() {
            return Err("work_not_directory");
        }
        let mut entries = fs::read_dir(&canonical).map_err(|_| "work_unreadable")?;
        match entries.next() {
            None => {}
            Some(Ok(_)) => return Err("work_not_empty"),
            Some(Err(_)) => return Err("work_unreadable"),
        }
    }

    let prepared =
        ensure_output_allowed(input, work, "").map_err(|error| work_error_code(&error))?;
    let target = prepared.target_root().to_path_buf();
    let mut entries = fs::read_dir(&target).map_err(|_| "work_unreadable")?;
    match entries.next() {
        None => Ok(target),
        Some(Ok(_)) => Err("work_not_empty"),
        Some(Err(_)) => Err("work_unreadable"),
    }
}

fn preferred_1920(record: &PhotoRecord) -> u8 {
    if record.name.to_ascii_lowercase().contains("_1920_1080") {
        0
    } else {
        1
    }
}

fn record_category(
    record: &PhotoRecord,
    output_prefix: &str,
    root_name: &str,
) -> Option<&'static str> {
    if let Some(first) = output_prefix.split('\\').next() {
        if let Some(category) = known_category(first) {
            return Some(category);
        }
    }
    if let Some(first) = record.relative_path.split('\\').next() {
        if let Some(category) = known_category(first) {
            return Some(category);
        }
    }
    known_category(root_name)
}

fn known_category(value: &str) -> Option<&'static str> {
    CATEGORIES
        .iter()
        .copied()
        .find(|category| category.eq_ignore_ascii_case(value))
}

fn bump(map: &mut BTreeMap<String, usize>, key: &str) {
    *map.entry(key.to_string()).or_insert(0) += 1;
}

fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn scan_error_code(error: &ScanError) -> &'static str {
    match error {
        ScanError::InputMissing => "input_missing",
        ScanError::InputNotDirectory => "input_not_directory",
        ScanError::Io(_) => "input_io",
    }
}

fn output_error_code(error: &OutputError) -> &'static str {
    match error {
        OutputError::InputMissing => "input_missing",
        OutputError::InputNotDirectory => "input_not_directory",
        OutputError::OutputNotDirectory => "output_not_directory",
        OutputError::OutputEqualsInput => "output_equals_input",
        OutputError::OutputInsideInput => "output_inside_input",
        OutputError::ProtectedOutput => "output_protected",
        OutputError::OutputInsideGameTree => "output_inside_game_tree",
        OutputError::OutputReparse => "output_reparse",
        OutputError::DestinationIsDirectory => "output_destination_is_directory",
        OutputError::ForbiddenDestination => "output_forbidden_destination",
        OutputError::UnsafeRelativePath => "output_unsafe_relative_path",
        OutputError::TooManyConflicts => "output_too_many_conflicts",
        OutputError::Io(_) => "output_io",
    }
}

fn work_error_code(error: &OutputError) -> &'static str {
    match error {
        OutputError::InputMissing => "input_missing",
        OutputError::InputNotDirectory => "input_not_directory",
        OutputError::OutputNotDirectory => "work_not_directory",
        OutputError::OutputEqualsInput => "work_equals_input",
        OutputError::OutputInsideInput => "work_inside_input",
        OutputError::ProtectedOutput => "work_protected",
        OutputError::OutputInsideGameTree => "work_inside_game_tree",
        OutputError::OutputReparse => "work_reparse",
        OutputError::DestinationIsDirectory => "work_not_directory",
        OutputError::ForbiddenDestination => "work_invalid",
        OutputError::UnsafeRelativePath => "work_unsafe_path",
        OutputError::TooManyConflicts => "work_invalid",
        OutputError::Io(_) => "work_io",
    }
}

fn batch_error_code(error: &BatchError) -> &'static str {
    match error {
        BatchError::MismatchedRoot => "batch_root_mismatch",
        BatchError::Io(_) => "batch_io",
    }
}

fn count_files(root: &Path) -> usize {
    let mut files = Vec::new();
    walk_files(root, &mut files);
    files.len()
}

fn count_temp_files(root: &Path) -> usize {
    let mut files = Vec::new();
    walk_files(root, &mut files);
    files
        .iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(".hdp-tmp-"))
                .unwrap_or(false)
        })
        .count()
}

fn walk_files(root: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            continue;
        }
        if meta.is_dir() {
            walk_files(&path, out);
        } else if meta.is_file() {
            out.push(path);
        }
    }
}

#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() >= 24 && bytes[..8] == PNG_SIGNATURE {
        return png_dimensions(bytes);
    }
    if bytes.len() >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return jpeg_dimensions(bytes);
    }
    None
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || bytes[..8] != PNG_SIGNATURE {
        return None;
    }
    if &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if width == 0 || height == 0 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE {
        return None;
    }
    Some((width, height))
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut position = 2usize;
    while position + 1 < bytes.len() {
        if bytes[position] != 0xFF {
            position += 1;
            continue;
        }
        let mut marker = bytes[position + 1];
        position += 2;
        while marker == 0xFF {
            if position >= bytes.len() {
                return None;
            }
            marker = bytes[position];
            position += 1;
        }
        if marker == 0xD8 || marker == 0xD9 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        if marker == 0xDA {
            // Start of scan before any SOF: not a decodable frame header.
            return None;
        }
        if position + 2 > bytes.len() {
            return None;
        }
        let segment_length = u16::from_be_bytes([bytes[position], bytes[position + 1]]) as usize;
        if segment_length < 2 || position + segment_length > bytes.len() {
            return None;
        }
        if is_sof_marker(marker) {
            if segment_length < 7 {
                return None;
            }
            let height = u16::from_be_bytes([bytes[position + 3], bytes[position + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[position + 5], bytes[position + 6]]) as u32;
            if width == 0 || height == 0 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE {
                return None;
            }
            return Some((width, height));
        }
        position += segment_length;
    }
    None
}

fn is_sof_marker(marker: u8) -> bool {
    matches!(
        marker,
        0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
    )
}

struct FixturePaths {
    root: PathBuf,
    output: PathBuf,
    cancel_root: PathBuf,
    cancel_output: PathBuf,
}

fn run_fixture_checks(
    paths: &FixturePaths,
    material: &CryptoMaterial,
    checks: &mut Checks,
) -> Value {
    let fixture_scan = match scan(&ScanRequest::new(&paths.root), &mut |_| {}) {
        Ok(result) => result,
        Err(_) => {
            checks.fail("negative_scan_failed");
            return json!({ "built": false });
        }
    };
    let prepared = match ensure_output_allowed(
        &fixture_scan.canonical_root,
        &paths.output,
        &fixture_scan.output_prefix,
    ) {
        Ok(prepared) => prepared,
        Err(_) => {
            checks.fail("negative_output_rejected");
            return json!({ "built": false });
        }
    };
    let request = BatchRequest {
        records: &fixture_scan.records,
        input_root: &fixture_scan.canonical_root,
        output: &prepared,
        material,
        conflict: ConflictPolicy::Skip,
        workers: 2,
        cancel: Arc::new(AtomicBool::new(false)),
        max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
        max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
    };
    let result = match run_batch(request, |_| {}) {
        Ok(result) => result,
        Err(_) => {
            checks.fail("negative_batch_failed");
            return json!({ "built": false });
        }
    };

    let empty = status_ok(
        &result.outcomes,
        "zero.png",
        FileStatus::Failed,
        Some("source_empty"),
    );
    let partial = status_ok(
        &result.outcomes,
        "partial.png",
        FileStatus::Failed,
        Some("source_not_block_aligned"),
    );
    let bad_padding = status_ok(
        &result.outcomes,
        "bad-padding.png",
        FileStatus::Failed,
        Some("decrypt_padding"),
    );
    let truncated = status_ok(
        &result.outcomes,
        "truncated.png",
        FileStatus::Failed,
        Some("not_image"),
    );
    let plain = status_ok(
        &result.outcomes,
        "plain.png",
        FileStatus::Failed,
        Some("not_image"),
    );

    let good = outcome_named(&result.outcomes, "good.png")
        .map(|outcome| success_output_ok(&prepared, outcome))
        .unwrap_or(false);
    let unicode = outcome_named(&result.outcomes, "中文 截图.png")
        .map(|outcome| success_output_ok(&prepared, outcome))
        .unwrap_or(false);
    let long_path = fixture_scan
        .records
        .iter()
        .find(|record| record.relative_path.chars().count() > 260)
        .and_then(|record| {
            result
                .outcomes
                .iter()
                .find(|outcome| outcome.relative_path == record.relative_path)
        })
        .map(|outcome| {
            outcome.status == FileStatus::Success && success_output_ok(&prepared, outcome)
        })
        .unwrap_or(false);

    let mut no_output = true;
    for outcome in &result.outcomes {
        if outcome.status != FileStatus::Failed {
            continue;
        }
        let Some(record) = fixture_scan
            .records
            .iter()
            .find(|record| record.relative_path == outcome.relative_path)
        else {
            continue;
        };
        for extension in ["png", "jpg", "jpeg"] {
            let mut relative = PathBuf::from(&record.relative_path);
            relative.set_extension(extension);
            if prepared.target_root().join(relative).exists() {
                no_output = false;
            }
        }
    }
    let file_count = count_files(prepared.root()) == result.succeeded as usize;
    let temps = count_temp_files(prepared.root()) == 0;
    let mix = result.succeeded == 3 && result.failed == 5 && result.skipped == 0;

    checks.require(empty, "negative_empty_failed");
    checks.require(partial, "negative_not_aligned_failed");
    checks.require(bad_padding, "negative_bad_padding_failed");
    checks.require(truncated, "negative_truncated_failed");
    checks.require(plain, "negative_not_image_failed");
    checks.require(good, "negative_good_failed");
    checks.require(unicode, "negative_unicode_failed");
    checks.require(long_path, "negative_long_path_failed");
    checks.require(no_output, "negative_output_leak");
    checks.require(file_count, "negative_file_count");
    checks.require(temps, "negative_temp_leftover");
    checks.require(mix, "negative_batch_mix");

    json!({
        "built": true,
        "empty": empty,
        "notBlockAligned": partial,
        "badPadding": bad_padding,
        "truncatedImage": truncated,
        "notImage": plain,
        "good": good,
        "unicode": unicode,
        "longPath": long_path,
        "noOutput": no_output,
        "fileCount": file_count,
        "tempFiles": temps
    })
}

fn run_cancellation_check(
    paths: &FixturePaths,
    material: &CryptoMaterial,
    checks: &mut Checks,
) -> (bool, usize) {
    let scan_result = match scan(&ScanRequest::new(&paths.cancel_root), &mut |_| {}) {
        Ok(result) => result,
        Err(_) => {
            checks.fail("cancel_scan_failed");
            return (false, 0);
        }
    };
    let prepared = match ensure_output_allowed(
        &scan_result.canonical_root,
        &paths.cancel_output,
        &scan_result.output_prefix,
    ) {
        Ok(prepared) => prepared,
        Err(_) => {
            checks.fail("cancel_output_rejected");
            return (false, 0);
        }
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let mut armed = false;
    let request = BatchRequest {
        records: &scan_result.records,
        input_root: &scan_result.canonical_root,
        output: &prepared,
        material,
        conflict: ConflictPolicy::Skip,
        workers: 1,
        cancel: cancel.clone(),
        max_cipher_bytes: DEFAULT_MAX_CIPHER_BYTES,
        max_plain_bytes: DEFAULT_MAX_PLAIN_BYTES,
    };
    let result = match run_batch(request, |tick| {
        if !armed && !tick.done {
            armed = true;
            cancel.store(true, Ordering::Relaxed);
        }
    }) {
        Ok(result) => result,
        Err(_) => {
            checks.fail("cancel_batch_failed");
            return (false, 0);
        }
    };
    let cancelled = result
        .outcomes
        .iter()
        .filter(|outcome| outcome.status == FileStatus::Cancelled)
        .count();
    let temps = count_temp_files(prepared.root());
    checks.require(
        result.cancelled && cancelled > 0,
        "batch_cancel_not_observed",
    );
    checks.require(temps == 0, "batch_cancel_temp_leftover");
    (result.cancelled && cancelled > 0, temps)
}

fn status_ok(
    outcomes: &[FileOutcome],
    name: &str,
    status: FileStatus,
    reason: Option<&str>,
) -> bool {
    match outcome_named(outcomes, name) {
        Some(outcome) => {
            outcome.status == status
                && reason
                    .map(|expected| outcome.reason.as_deref() == Some(expected))
                    .unwrap_or(true)
        }
        None => false,
    }
}

fn outcome_named<'a>(outcomes: &'a [FileOutcome], name: &str) -> Option<&'a FileOutcome> {
    outcomes.iter().find(|outcome| outcome.name == name)
}

fn success_output_ok(prepared: &PreparedOutput, outcome: &FileOutcome) -> bool {
    let Some(relative) = outcome.output_relative_path.as_deref() else {
        return false;
    };
    let path = prepared.root().join(relative);
    match fs::read(&path) {
        Ok(bytes) => decode_verified(&bytes).is_ok() && image_dimensions(&bytes).is_some(),
        Err(_) => false,
    }
}

fn build_fixtures(work: &Path, material: &CryptoMaterial) -> Result<FixturePaths, &'static str> {
    let mut entries = fs::read_dir(work).map_err(|_| "work_unreadable")?;
    match entries.next() {
        None => {}
        Some(Ok(_)) => return Err("work_not_empty"),
        Some(Err(_)) => return Err("work_unreadable"),
    }

    let root = work.join("ScreenCapture");
    let photo = root.join("Photo");
    fs::create_dir_all(&photo).map_err(|_| "fixture_setup_failed")?;

    let tiny = build_png(2, 2);
    let tiny_cipher = material
        .encrypt(&tiny)
        .map_err(|_| "fixture_encrypt_failed")?;
    fs::write(photo.join("good.png"), &tiny_cipher).map_err(|_| "fixture_setup_failed")?;
    fs::write(photo.join("zero.png"), b"").map_err(|_| "fixture_setup_failed")?;
    fs::write(photo.join("partial.png"), [0x5Au8; 17]).map_err(|_| "fixture_setup_failed")?;

    let bad_padding = make_bad_padding(material, &tiny_cipher)?;
    fs::write(photo.join("bad-padding.png"), bad_padding).map_err(|_| "fixture_setup_failed")?;

    let truncated = &tiny[..tiny.len().saturating_sub(20)];
    let truncated_cipher = material
        .encrypt(truncated)
        .map_err(|_| "fixture_encrypt_failed")?;
    fs::write(photo.join("truncated.png"), truncated_cipher).map_err(|_| "fixture_setup_failed")?;

    let plain = b"acceptance fixture: not an image";
    let plain_cipher = material
        .encrypt(plain)
        .map_err(|_| "fixture_encrypt_failed")?;
    fs::write(photo.join("plain.png"), plain_cipher).map_err(|_| "fixture_setup_failed")?;

    fs::write(photo.join("中文 截图.png"), &tiny_cipher).map_err(|_| "fixture_setup_failed")?;
    let mut long_dir = photo.clone();
    for index in 0..10 {
        long_dir.push(format!("深层目录-{index}-{}", "长".repeat(20)));
    }
    fs::create_dir_all(&long_dir).map_err(|_| "fixture_setup_failed")?;
    fs::write(long_dir.join("长路径结果.png"), &tiny_cipher).map_err(|_| "fixture_setup_failed")?;

    let cancel_root = work.join("cancel").join("ScreenCapture");
    let cancel_photo = cancel_root.join("Photo");
    fs::create_dir_all(&cancel_photo).map_err(|_| "fixture_setup_failed")?;
    let large = build_png(512, 512);
    let large_cipher = material
        .encrypt(&large)
        .map_err(|_| "fixture_encrypt_failed")?;
    for index in 0..16 {
        fs::write(cancel_photo.join(format!("c{index:02}.png")), &large_cipher)
            .map_err(|_| "fixture_setup_failed")?;
    }

    Ok(FixturePaths {
        root,
        output: work.join("out"),
        cancel_root,
        cancel_output: work.join("cancel").join("out"),
    })
}

fn make_bad_padding(material: &CryptoMaterial, valid: &[u8]) -> Result<Vec<u8>, &'static str> {
    if valid.len() < 16 {
        return Err("fixture_bad_padding");
    }
    let mut candidate = valid.to_vec();
    let last = candidate.len() - 16;
    for attempt in 0..256u32 {
        for offset in 0..16 {
            candidate[last + offset] = if attempt == 0 {
                0
            } else {
                (attempt as u8)
                    .wrapping_mul(37)
                    .wrapping_add((offset as u8).wrapping_mul(11))
                    .wrapping_add(1)
            };
        }
        if matches!(
            material.decrypt(&candidate, DEFAULT_MAX_PLAIN_BYTES),
            Err(CryptoError::BadPadding)
        ) {
            return Ok(candidate);
        }
    }
    Err("fixture_bad_padding")
}

fn build_png(width: u32, height: u32) -> Vec<u8> {
    let mut raw = Vec::with_capacity((width as usize * 4 + 1) * height as usize);
    for y in 0..height {
        raw.push(0);
        for x in 0..width {
            raw.push((x % 256) as u8);
            raw.push((y % 256) as u8);
            raw.push(((x + y) % 256) as u8);
            raw.push(255);
        }
    }

    let mut png = Vec::new();
    png.extend_from_slice(&PNG_SIGNATURE);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    write_chunk(&mut png, b"IHDR", &ihdr);
    write_chunk(&mut png, b"IDAT", &zlib_store(&raw));
    write_chunk(&mut png, b"IEND", &[]);
    png
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn zlib_store(raw: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut offset = 0usize;
    while offset < raw.len() {
        let length = (raw.len() - offset).min(65_535);
        let final_block = offset + length == raw.len();
        out.push(if final_block { 1 } else { 0 });
        out.extend_from_slice(&(length as u16).to_le_bytes());
        out.extend_from_slice(&(!(length as u16)).to_le_bytes());
        out.extend_from_slice(&raw[offset..offset + length]);
        offset += length;
    }
    if raw.is_empty() {
        out.push(1);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in data {
        a = (a + byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}
