use crate::{
    config::{validate_filters, Config},
    models::{AppView, Filters, LogEntry, PhotoView, ScanProgress, TaskProgress, UpdateView},
    state::{AppState, FailureRow, ScanState, TaskState},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use heartopia_photo_core::{
    ensure_output_allowed, read_snapshot, run_batch, scan, validate_export_target,
    validate_output_target, BatchRequest, ConflictPolicy, FileStatus, PhotoRecord, ScanRequest,
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use uuid::Uuid;

const MAX_CIPHER_BYTES: u64 = 32 * 1024 * 1024 + 16;
const MAX_THUMBNAIL_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

fn update_download_timeout() -> Duration {
    Duration::from_secs(15 * 60)
}

fn error(message: &'static str) -> String {
    message.to_owned()
}

fn log(app: &AppHandle, state: &AppState, level: &str, message: &str) {
    let entry = state.logger.add(level, message);
    let _ = app.emit("app-log", entry);
}

fn app_view(state: &AppState) -> AppView {
    state
        .config
        .lock()
        .view(state.version.clone(), state.material.is_some())
}

fn ensure_idle(state: &AppState) -> Result<(), String> {
    if state.is_busy() {
        return Err(error("任务进行中，请等待完成或先取消任务"));
    }
    Ok(())
}

fn validate_input(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(error("请选择完整的目录路径"));
    }
    let meta = fs::metadata(path).map_err(|_| error("输入目录不存在或无法访问"))?;
    if !meta.is_dir() {
        return Err(error("输入位置不是目录"));
    }
    fs::canonicalize(path).map_err(|_| error("输入目录无法解析"))
}

fn validate_directory_change(config: &Config, kind: &str, path: &Path) -> Result<PathBuf, String> {
    match kind {
        "input" => {
            let input = validate_input(path)?;
            if let Some(output) = &config.output {
                validate_output_target(&input, &output.path)
                    .map_err(|_| error("输出目录不能与输入目录相同或位于输入目录内"))?;
            }
            Ok(input)
        }
        "output" => {
            let input = config
                .input
                .as_ref()
                .ok_or_else(|| error("请先选择输入目录"))?;
            validate_output_target(&input.path, path)
                .map_err(|_| error("输出目录不能与输入目录相同、位于输入目录内，或位于受保护位置"))
        }
        _ => Err(error("目录类型无效")),
    }
}

#[tauri::command]
pub fn get_app_state(state: State<'_, AppState>) -> AppView {
    app_view(&state)
}

#[tauri::command]
pub fn set_directory(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    path: String,
) -> Result<AppView, String> {
    let _operation = state.operation_lock.lock();
    ensure_idle(&state)?;
    let selected = {
        let config = state.config.lock();
        validate_directory_change(&config, &kind, Path::new(&path))?
    };
    {
        let mut config = state.config.lock();
        config.set_directory(&kind, selected)?;
        config.save(&state.config_dir)?;
    }
    if kind == "input" {
        *state.scan.lock() = ScanState::default();
    }
    log(&app, &state, "info", "目录设置已更新并保存。");
    Ok(app_view(&state))
}

#[tauri::command]
pub fn select_recent(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    token: String,
) -> Result<AppView, String> {
    let _operation = state.operation_lock.lock();
    ensure_idle(&state)?;
    let selected = {
        let config = state.config.lock();
        let list = match kind.as_str() {
            "input" => &config.recent_inputs,
            "output" => &config.recent_outputs,
            _ => return Err(error("目录类型无效")),
        };
        let item = list
            .iter()
            .find(|item| item.token == token)
            .ok_or_else(|| error("最近使用的目录已失效"))?
            .clone();
        validate_directory_change(&config, &kind, &item.path)?;
        item
    };
    {
        let mut config = state.config.lock();
        match kind.as_str() {
            "input" => {
                config
                    .recent_inputs
                    .retain(|item| item.token != selected.token);
                config.recent_inputs.insert(0, selected.clone());
                config.input = Some(selected);
            }
            "output" => {
                config
                    .recent_outputs
                    .retain(|item| item.token != selected.token);
                config.recent_outputs.insert(0, selected.clone());
                config.output = Some(selected);
            }
            _ => return Err(error("目录类型无效")),
        }
        config.save(&state.config_dir)?;
    }
    if kind == "input" {
        *state.scan.lock() = ScanState::default();
    }
    log(&app, &state, "info", "已切换到最近使用的目录。");
    Ok(app_view(&state))
}

#[tauri::command]
pub fn auto_detect_input(app: AppHandle, state: State<'_, AppState>) -> Result<AppView, String> {
    let _operation = state.operation_lock.lock();
    ensure_idle(&state)?;
    let detected = detect_screen_capture()
        .ok_or_else(|| error("未自动找到 ScreenCapture 目录，请手动选择"))?;
    let selected = {
        let config = state.config.lock();
        validate_directory_change(&config, "input", &detected)?
    };
    {
        let mut config = state.config.lock();
        config.set_directory("input", selected)?;
        config.save(&state.config_dir)?;
    }
    *state.scan.lock() = ScanState::default();
    log(&app, &state, "info", "已自动找到并设置图片目录。");
    Ok(app_view(&state))
}

fn is_reparse(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        fs::symlink_metadata(path)
            .map(|meta| meta.file_attributes() & 0x400 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn detect_screen_capture() -> Option<PathBuf> {
    let profile = std::env::var_os("USERPROFILE")?;
    let default = PathBuf::from(&profile)
        .join("AppData")
        .join("LocalLow")
        .join("xd")
        .join("心动小镇")
        .join("ScreenCapture");
    let mut candidates: Vec<(SystemTime, PathBuf)> = Vec::new();
    if default.is_dir() {
        let modified = fs::metadata(&default)
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        candidates.push((modified, default));
    }
    let local_low = PathBuf::from(&profile)
        .join("AppData")
        .join("LocalLow")
        .join("xd");
    if let Ok(entries) = fs::read_dir(local_low) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_reparse(&path) {
                continue;
            }
            let lower_name = entry.file_name().to_string_lossy().to_lowercase();
            if lower_name.contains("backup") || !path.is_dir() {
                continue;
            }
            let capture = path.join("ScreenCapture");
            if !capture.is_dir() {
                continue;
            }
            let modified = fs::metadata(path.join("Player.log"))
                .or_else(|_| fs::metadata(&capture))
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if !candidates.iter().any(|(_, existing)| existing == &capture) {
                candidates.push((modified, capture));
            }
        }
    }
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    candidates.into_iter().next().map(|(_, path)| path)
}

#[tauri::command]
pub fn save_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    filters: Filters,
    conflict_policy: String,
    workers: u8,
    auto_check_updates: bool,
) -> Result<AppView, String> {
    validate_filters(&filters)?;
    if !matches!(conflict_policy.as_str(), "skip" | "rename") {
        return Err(error("重名处理方式无效"));
    }
    {
        let mut config = state.config.lock();
        config.filters = filters;
        config.conflict_policy = conflict_policy;
        config.workers = workers.clamp(1, 8);
        config.auto_check_updates = auto_check_updates;
        config.save(&state.config_dir)?;
    }
    log(&app, &state, "info", "界面偏好已保存。");
    Ok(app_view(&state))
}

fn photo_view(record: &PhotoRecord, status: &str) -> PhotoView {
    PhotoView {
        id: record.id.clone(),
        name: record.name.clone(),
        relative_path: record.relative_path.clone(),
        directory: record.directory.clone(),
        size: record.size,
        extension: record.extension.clone(),
        date: record.date.clone(),
        timestamp_ms: record.timestamp_ms,
        date_source: record.date_source.as_str().to_owned(),
        status: status.to_owned(),
    }
}

#[tauri::command]
pub async fn scan_photos(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let _operation = state.operation_lock.lock();
    ensure_idle(&state)?;
    let input = {
        let config = state.config.lock();
        config
            .input
            .as_ref()
            .map(|item| item.path.clone())
            .ok_or_else(|| error("请先选择输入目录"))?
    };
    if let Some(output) = state.config.lock().output.as_ref() {
        validate_output_target(&input, &output.path)
            .map_err(|_| error("输入与输出目录关系无效，请重新选择"))?;
    }
    let scan_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut runtime = state.scan.lock();
        *runtime = ScanState {
            running: true,
            cancel: Some(cancel.clone()),
            ..ScanState::default()
        };
    }
    log(&app, &state, "info", "开始扫描图片目录。");
    let state_owned = state.inner().clone();
    let app_owned = app.clone();
    let scan_id_for_task = scan_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let request = ScanRequest {
            input_root: &input,
            now_ms: heartopia_photo_core::now_unix_ms(),
            cancel,
        };
        let runtime = state_owned.scan.clone();
        let mut last_emit = Instant::now();
        let result = scan(&request, &mut |tick| {
            let progress = ScanProgress {
                scan_id: scan_id_for_task.clone(),
                scanned: tick.scanned,
                found: tick.found,
                errors: tick.errors,
                complete: tick.complete,
                cancelled: tick.cancelled,
                elapsed_ms: tick.elapsed_ms,
            };
            {
                let mut scan_state = runtime.lock();
                scan_state.progress = Some(progress.clone());
                scan_state.cancelled = tick.cancelled;
                if tick.complete {
                    scan_state.complete = true;
                }
            }
            // Publish terminal state only after the immutable index is available to list_photos.
            if !tick.complete && last_emit.elapsed() >= Duration::from_millis(80) {
                last_emit = Instant::now();
                let _ = app_owned.emit("scan-progress", progress);
            }
        });
        let mut scan_state = runtime.lock();
        scan_state.running = false;
        scan_state.cancel = None;
        match result {
            Ok(result) => {
                scan_state.complete = !result.cancelled;
                scan_state.cancelled = result.cancelled;
                let count = result.records.len();
                scan_state.records = result.records;
                scan_state.input_root = Some(result.canonical_root);
                scan_state.output_prefix = result.output_prefix;
                let photos = scan_state
                    .records
                    .iter()
                    .map(|record| photo_view(record, "pending"))
                    .collect::<Vec<_>>();
                let index = photos
                    .iter()
                    .enumerate()
                    .map(|(position, photo)| (photo.id.clone(), position))
                    .collect::<HashMap<_, _>>();
                scan_state.photos = photos;
                scan_state.index = index;
                let errors = result.errors;
                let cancelled = result.cancelled;
                let elapsed = result.elapsed_ms;
                let final_progress = ScanProgress {
                    scan_id: scan_id_for_task.clone(),
                    scanned: result.scanned,
                    found: count as u64,
                    errors,
                    complete: true,
                    cancelled,
                    elapsed_ms: elapsed,
                };
                scan_state.progress = Some(final_progress.clone());
                drop(scan_state);
                let _ = app_owned.emit("scan-progress", final_progress);
                if cancelled {
                    log(
                        &app_owned,
                        &state_owned,
                        "warn",
                        &format!("扫描已取消，已索引 {count} 张图片。"),
                    );
                } else {
                    log(
                        &app_owned,
                        &state_owned,
                        "info",
                        &format!(
                            "扫描完成：{count} 张图片，{errors} 项无法读取，用时 {elapsed} ms。"
                        ),
                    );
                }
            }
            Err(_) => {
                scan_state.complete = true;
                scan_state.cancelled = true;
                drop(scan_state);
                let progress = ScanProgress {
                    scan_id: scan_id_for_task.clone(),
                    scanned: 0,
                    found: 0,
                    errors: 1,
                    complete: true,
                    cancelled: true,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                };
                let _ = app_owned.emit("scan-progress", progress);
                log(
                    &app_owned,
                    &state_owned,
                    "error",
                    "扫描失败：输入目录无法读取。",
                );
            }
        }
    });
    Ok(scan_id)
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, AppState>) -> Result<(), String> {
    let runtime = state.scan.lock();
    if let Some(cancel) = &runtime.cancel {
        cancel.store(true, Ordering::Relaxed);
        Ok(())
    } else if runtime.running {
        Ok(())
    } else {
        Err(error("当前没有正在进行的扫描"))
    }
}

#[tauri::command]
pub fn list_photos(state: State<'_, AppState>) -> Vec<PhotoView> {
    state.scan.lock().photos.clone()
}

#[tauri::command]
pub async fn get_thumbnail(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    if let Some(cached) = state.thumbnails.lock().get(&id).cloned() {
        return Ok(Some((*cached).clone()));
    }
    let material = state
        .material
        .clone()
        .ok_or_else(|| error("此构建未包含解密密钥，无法生成预览"))?;
    let (record, input_root) = {
        let scan_state = state.scan.lock();
        let index = *scan_state
            .index
            .get(&id)
            .ok_or_else(|| error("图片索引已失效，请重新扫描"))?;
        let record = scan_state
            .records
            .get(index)
            .cloned()
            .ok_or_else(|| error("图片索引已失效，请重新扫描"))?;
        let root = scan_state
            .input_root
            .clone()
            .ok_or_else(|| error("图片索引已失效，请重新扫描"))?;
        (record, root)
    };
    let permit = state
        .thumbnail_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| error("预览服务暂不可用"))?;
    let cache = state.thumbnails.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let bytes = read_snapshot(&record, &input_root, MAX_THUMBNAIL_SOURCE_BYTES)
            .map_err(|_| error("图片已发生变化或不可读取，请重新扫描"))?;
        let thumbnail = heartopia_photo_core::thumbnail_from_ciphertext(
            &material,
            &bytes,
            MAX_THUMBNAIL_SOURCE_BYTES,
        )
        .map_err(|_| error("预览生成失败，可能不是有效图片"))?;
        let encoded = Arc::new(format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(&thumbnail.jpeg)
        ));
        cache.lock().put(id, encoded.clone());
        Ok::<Option<String>, String>(Some((*encoded).clone()))
    })
    .await
    .map_err(|_| error("预览服务暂不可用"))??;
    Ok(result)
}

fn file_status_code(status: FileStatus) -> &'static str {
    match status {
        FileStatus::Success => "success",
        FileStatus::Failed => "failed",
        FileStatus::Skipped => "skipped",
        FileStatus::Cancelled => "cancelled",
    }
}

#[tauri::command]
pub fn start_decryption(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<String, String> {
    let _operation = state.operation_lock.lock();
    ensure_idle(&state)?;
    if ids.is_empty() {
        return Err(error("请选择至少一张图片"));
    }
    if ids.len() > 100_000 {
        return Err(error("单次选择的图片数量过多"));
    }
    let material = state
        .material
        .clone()
        .ok_or_else(|| error("此构建未包含解密密钥，无法处理图片"))?;
    let (records, input_root, prefix) = {
        let scan_state = state.scan.lock();
        let input_root = scan_state
            .input_root
            .clone()
            .ok_or_else(|| error("请先扫描图片目录"))?;
        let mut seen = HashSet::new();
        let mut selected = Vec::new();
        for id in &ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let index = *scan_state
                .index
                .get(id)
                .ok_or_else(|| error("部分图片索引已失效，请重新扫描"))?;
            selected.push(scan_state.records[index].clone());
        }
        (selected, input_root, scan_state.output_prefix.clone())
    };
    if records.is_empty() {
        return Err(error("请选择至少一张图片"));
    }
    let output = state
        .config
        .lock()
        .output
        .as_ref()
        .map(|item| item.path.clone())
        .ok_or_else(|| error("请先选择输出目录"))?;
    let (conflict, workers) = {
        let config = state.config.lock();
        let conflict = if config.conflict_policy == "rename" {
            ConflictPolicy::Rename
        } else {
            ConflictPolicy::Skip
        };
        (conflict, config.workers)
    };
    let prepared = ensure_output_allowed(&input_root, &output, &prefix)
        .map_err(|_| error("输出目录不可用，请重新选择"))?;
    let job_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut task = state.task.lock();
        *task = TaskState {
            running: true,
            cancel: Some(cancel.clone()),
            ..TaskState::default()
        };
        drop(task);
        let mut scan_state = state.scan.lock();
        for id in &ids {
            if let Some(index) = scan_state.index.get(id).copied() {
                if let Some(photo) = scan_state.photos.get_mut(index) {
                    photo.status = "pending".to_owned();
                }
            }
        }
    }
    log(
        &app,
        &state,
        "info",
        &format!("开始批量解密 {} 张图片。", records.len()),
    );
    let state_owned = state.inner().clone();
    let app_owned = app.clone();
    let job_id_for_task = job_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let total = records.len();
        let mut request = BatchRequest::new(&records, &input_root, &prepared, material.as_ref());
        request.conflict = conflict;
        request.workers = workers as usize;
        request.cancel = cancel;
        request.max_cipher_bytes = MAX_CIPHER_BYTES;
        let result = run_batch(request, |tick| {
            if tick.done {
                return;
            }
            let progress = TaskProgress {
                job_id: job_id_for_task.clone(),
                total: tick.total as usize,
                completed: tick.completed as usize,
                succeeded: tick.succeeded as usize,
                failed: tick.failed as usize,
                skipped: tick.skipped as usize,
                cancelled: tick.cancelled,
                done: false,
                elapsed_ms: tick.elapsed_ms,
                current_id: tick.current_id.clone(),
                current_status: tick
                    .current_status
                    .map(|status| file_status_code(status).to_owned()),
                reason: tick.reason.clone(),
            };
            if let (Some(id), Some(status)) = (&tick.current_id, tick.current_status) {
                let mut scan_state = state_owned.scan.lock();
                if let Some(index) = scan_state.index.get(id).copied() {
                    scan_state.photos[index].status = file_status_code(status).to_owned();
                }
            }
            if let Some(reason) = &tick.reason {
                if tick.current_status == Some(FileStatus::Failed) {
                    log(
                        &app_owned,
                        &state_owned,
                        "warn",
                        &format!("单文件失败：{reason}。"),
                    );
                }
            }
            state_owned.task.lock().progress = Some(progress.clone());
            let _ = app_owned.emit("task-progress", progress);
        });
        let task_runtime = state_owned.task.clone();
        let scan_runtime = state_owned.scan.clone();
        match result {
            Ok(result) => {
                let mut failures = Vec::new();
                {
                    let mut scan_state = scan_runtime.lock();
                    for outcome in &result.outcomes {
                        if let Some(index) = scan_state.index.get(&outcome.id).copied() {
                            if let Some(photo) = scan_state.photos.get_mut(index) {
                                photo.status = file_status_code(outcome.status).to_owned();
                            }
                        }
                        if outcome.status == FileStatus::Failed {
                            failures.push(FailureRow {
                                name: outcome.name.clone(),
                                relative_path: outcome.relative_path.clone(),
                                reason: outcome
                                    .reason
                                    .clone()
                                    .unwrap_or_else(|| "unknown".to_owned()),
                            });
                        }
                    }
                }
                let progress = TaskProgress {
                    job_id: job_id_for_task.clone(),
                    total,
                    completed: total,
                    succeeded: result.succeeded as usize,
                    failed: result.failed as usize,
                    skipped: result.skipped as usize,
                    cancelled: result.cancelled,
                    done: true,
                    elapsed_ms: result.elapsed_ms,
                    current_id: None,
                    current_status: None,
                    reason: None,
                };
                {
                    let mut task = task_runtime.lock();
                    task.running = false;
                    task.cancel = None;
                    task.failures = failures;
                    task.progress = Some(progress.clone());
                }
                let _ = app_owned.emit("task-progress", progress);
                log(
                    &app_owned,
                    &state_owned,
                    if result.failed > 0 { "warn" } else { "info" },
                    &format!(
                        "批量解密完成：成功 {}，失败 {}，跳过 {}。",
                        result.succeeded, result.failed, result.skipped
                    ),
                );
            }
            Err(_) => {
                {
                    let mut scan_state = scan_runtime.lock();
                    for record in &records {
                        if let Some(index) = scan_state.index.get(&record.id).copied() {
                            if let Some(photo) = scan_state.photos.get_mut(index) {
                                photo.status = "failed".to_owned();
                            }
                        }
                    }
                }
                let progress = TaskProgress {
                    job_id: job_id_for_task.clone(),
                    total,
                    completed: 0,
                    succeeded: 0,
                    failed: total,
                    skipped: 0,
                    cancelled: false,
                    done: true,
                    elapsed_ms: 0,
                    current_id: None,
                    current_status: None,
                    reason: Some("output_unavailable".to_owned()),
                };
                {
                    let mut task = task_runtime.lock();
                    task.running = false;
                    task.cancel = None;
                    task.progress = Some(progress.clone());
                }
                let _ = app_owned.emit("task-progress", progress);
                log(
                    &app_owned,
                    &state_owned,
                    "error",
                    "批处理启动失败：输出目录或输入快照不可用。",
                );
            }
        }
    });
    Ok(job_id)
}

#[tauri::command]
pub fn cancel_decryption(state: State<'_, AppState>) -> Result<(), String> {
    let runtime = state.task.lock();
    if let Some(cancel) = &runtime.cancel {
        cancel.store(true, Ordering::Relaxed);
        Ok(())
    } else if runtime.running {
        Ok(())
    } else {
        Err(error("当前没有正在进行的解密任务"))
    }
}

#[tauri::command]
pub fn get_logs(state: State<'_, AppState>) -> Vec<LogEntry> {
    state.logger.entries()
}

#[tauri::command]
pub fn open_logs_directory(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    app.opener()
        .open_path(
            state.logger.directory().to_string_lossy().to_string(),
            None::<&str>,
        )
        .map_err(|_| error("无法打开日志目录"))
}

#[tauri::command]
pub fn open_output_directory(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let path = state
        .config
        .lock()
        .output
        .as_ref()
        .map(|item| item.path.clone())
        .ok_or_else(|| error("尚未选择输出目录"))?;
    if !path.is_dir() {
        return Err(error("输出目录尚未创建或不可访问"));
    }
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| error("无法打开输出目录"))
}

fn forbidden_export_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(input) = state.config.lock().input.as_ref() {
        roots.push(input.path.clone());
    }
    roots.push(state.config_dir.clone());
    roots.push(state.logger.directory().to_path_buf());
    if let Ok(profile) = std::env::var("USERPROFILE") {
        roots.push(
            PathBuf::from(profile)
                .join("AppData")
                .join("LocalLow")
                .join("xd"),
        );
    }
    roots
}

fn write_export(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| error("导出位置无效"))?;
    if !parent.is_dir() {
        return Err(error("导出位置不存在"));
    }
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| error("无法写入导出文件"))?;
    temp.write_all(bytes)
        .map_err(|_| error("无法写入导出文件"))?;
    temp.as_file()
        .sync_all()
        .map_err(|_| error("无法完成导出文件"))?;
    temp.persist_noclobber(path)
        .map_err(|_| error("目标文件已存在或被占用"))?;
    Ok(())
}

#[tauri::command]
pub fn export_logs(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let destination = validate_export_target(Path::new(&path), &forbidden_export_roots(&state))
        .map_err(|_| error("导出位置不安全或不可用"))?;
    let bytes = state.logger.export_bytes()?;
    write_export(&destination, &bytes)?;
    log(&app, &state, "info", "日志已导出。");
    Ok(())
}

#[tauri::command]
pub fn export_failures(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let destination = validate_export_target(Path::new(&path), &forbidden_export_roots(&state))
        .map_err(|_| error("导出位置不安全或不可用"))?;
    let failures = &state.task.lock().failures;
    if failures.is_empty() {
        return Err(error("当前没有可导出的失败记录"));
    }
    let mut csv = String::from("name,relative_path,reason\r\n");
    for row in failures {
        let clean = csv_cell;
        csv.push_str(&format!(
            "\"{}\",\"{}\",\"{}\"\r\n",
            clean(&row.name),
            clean(&row.relative_path),
            clean(&row.reason)
        ));
    }
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(csv.as_bytes());
    write_export(&destination, &bytes)?;
    log(
        &app,
        &state,
        "info",
        &format!("失败清单已导出，共 {} 条。", failures.len()),
    );
    Ok(())
}

fn csv_cell(value: &str) -> String {
    let trimmed = value.trim_start();
    let prefix = if trimmed.starts_with(['=', '+', '-', '@']) {
        "'"
    } else {
        ""
    };
    let escaped = value
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .replace('"', "\"\"");
    format!("{prefix}{escaped}")
}

#[tauri::command]
pub fn record_filter(
    app: AppHandle,
    state: State<'_, AppState>,
    visible: usize,
    selected: usize,
) -> Result<(), String> {
    if visible > 1_000_000 || selected > 1_000_000 {
        return Err(error("筛选计数异常"));
    }
    log(
        &app,
        &state,
        "info",
        &format!("筛选结果：可见 {visible} 张，已选 {selected} 张。"),
    );
    Ok(())
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateView, String> {
    {
        let mut runtime = state.update.lock();
        if runtime.busy {
            return Err(error("更新任务正在进行中"));
        }
        runtime.busy = true;
        runtime.view = UpdateView::new("checking", runtime.view.current_version.clone());
        runtime.update = None;
        runtime.bytes = None;
    }
    let current = state.version.clone();
    let updater = app
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|_| error("更新服务暂不可用"));
    let result = match updater {
        Ok(updater) => updater
            .check()
            .await
            .map_err(|_| error("检查更新失败，可离线继续使用")),
        Err(message) => Err(message),
    };
    let mut runtime = state.update.lock();
    runtime.busy = false;
    match result {
        Ok(Some(mut update)) => {
            let allowed = update.download_url.scheme() == "https"
                && update.download_url.host_str() == Some("github.com")
                && update
                    .download_url
                    .path()
                    .starts_with("/Airisua/heartopia-photo-tool/releases/download/");
            if !allowed {
                let mut view = UpdateView::new("error", current);
                view.message = Some("更新下载地址不属于已配置的发布仓库".into());
                runtime.view = view.clone();
                return Ok(view);
            }
            update.timeout = Some(update_download_timeout());
            let mut view = UpdateView::new("available", current);
            view.version = Some(update.version.clone());
            view.notes = update.body.clone();
            runtime.update = Some(update);
            runtime.bytes = None;
            runtime.view = view.clone();
            drop(runtime);
            log(&app, &state, "info", "发现可用更新。");
            Ok(view)
        }
        Ok(None) => {
            let view = UpdateView::new("upToDate", current);
            runtime.update = None;
            runtime.bytes = None;
            runtime.view = view.clone();
            drop(runtime);
            log(&app, &state, "info", "当前版本已是最新。");
            Ok(view)
        }
        Err(message) => {
            let mut view = UpdateView::new("error", current);
            view.message = Some(message);
            runtime.view = view.clone();
            drop(runtime);
            log(&app, &state, "warn", "检查更新失败，不影响离线使用。");
            Ok(view)
        }
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let update = {
        let mut runtime = state.update.lock();
        if runtime.busy {
            return Err(error("更新任务正在进行中"));
        }
        let update = runtime
            .update
            .clone()
            .ok_or_else(|| error("请先检查更新"))?;
        runtime.busy = true;
        runtime.view = UpdateView {
            status: "downloading".to_owned(),
            current_version: state.version.clone(),
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            downloaded: 0,
            total: None,
            message: None,
        };
        update
    };
    let update_state = state.update.clone();
    let app_events = app.clone();
    let result = update
        .download(
            |chunk, total| {
                let mut runtime = update_state.lock();
                let mut view = runtime.view.clone();
                view.status = "downloading".to_owned();
                view.downloaded = view.downloaded.saturating_add(chunk as u64);
                view.total = total;
                runtime.view = view.clone();
                drop(runtime);
                let _ = app_events.emit("update-progress", view);
            },
            || {},
        )
        .await;
    let mut runtime = state.update.lock();
    runtime.busy = false;
    match result {
        Ok(bytes) if bytes.len() as u64 <= MAX_UPDATE_BYTES => {
            runtime.bytes = Some(bytes);
            let mut view = runtime.view.clone();
            view.status = "ready".to_owned();
            view.message = None;
            runtime.view = view.clone();
            drop(runtime);
            let _ = app.emit("update-progress", view);
            log(&app, &state, "info", "更新包已下载并通过签名校验。");
            Ok(())
        }
        Ok(_) => {
            let mut view = UpdateView::new("error", state.version.clone());
            view.message = Some("更新包超过允许大小".to_owned());
            runtime.view = view.clone();
            drop(runtime);
            let _ = app.emit("update-progress", view);
            Err(error("更新包超过允许大小"))
        }
        Err(_) => {
            let mut view = UpdateView::new("error", state.version.clone());
            view.message = Some("更新下载失败，当前版本仍可正常使用".to_owned());
            runtime.view = view.clone();
            drop(runtime);
            let _ = app.emit("update-progress", view);
            log(&app, &state, "warn", "更新下载失败，当前版本未受影响。");
            Err(error("更新下载失败，当前版本仍可正常使用"))
        }
    }
}

#[tauri::command]
pub fn restart_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _operation = state.operation_lock.lock();
    ensure_idle(&state)?;
    let (update, bytes) = {
        let runtime = state.update.lock();
        (
            runtime
                .update
                .clone()
                .ok_or_else(|| error("没有可安装的更新"))?,
            runtime
                .bytes
                .clone()
                .ok_or_else(|| error("更新包尚未下载完成"))?,
        )
    };
    update
        .verify(&bytes)
        .map_err(|_| error("更新包校验失败，当前版本未受影响"))?;
    log(&app, &state, "info", "正在安装已校验的更新。");
    update
        .install(bytes)
        .map_err(|_| error("更新安装失败，当前版本未受影响"))?;
    Ok(())
}

#[cfg(test)]
mod update_policy_tests {
    use super::{update_download_timeout, UPDATE_CHECK_TIMEOUT};
    use std::time::Duration;

    #[test]
    fn installer_download_does_not_inherit_the_short_metadata_deadline() {
        assert!(update_download_timeout() > UPDATE_CHECK_TIMEOUT);
        assert!(update_download_timeout() >= Duration::from_secs(10 * 60));
    }
}
