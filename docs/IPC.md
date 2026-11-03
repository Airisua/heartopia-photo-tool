# IPC contract v1

All command arguments and payloads are camelCase JSON. Frontend never receives absolute source/output/log/config paths or key material. Native dialog selections may be passed directly to `set_directory`, never rendered or logged. Exceptions exposed to UI are stable sanitized Chinese messages.

## Models

`DirectoryView = { token: string, label: string }` (label = last directory component only).

`Filters = { directory: string, extension: string, startDate: string, endDate: string, query: string, datePreset: "all"|"today"|"7d"|"30d"|"custom" }`; empty fields mean all. Dates are ISO local YYYY-MM-DD.

`AppView = { version: string, input: DirectoryView|null, output: DirectoryView|null, recentInputs: DirectoryView[], recentOutputs: DirectoryView[], filters: Filters, conflictPolicy: "skip"|"rename", workers: number, autoCheckUpdates: boolean, keyAvailable: boolean }`.

`PhotoView = { id: string, name: string, relativePath: string, directory: string, size: number, extension: string, date: string, timestampMs: number, dateSource: "filetime"|"modified", status: "pending"|"success"|"failed"|"skipped"|"cancelled" }`.

Evidence correction: actual Heartopia IDs are Windows FILETIME ticks (100 ns since 1601-01-01 UTC), not Twitter-style snowflakes. Convert verified plausible IDs to Unix milliseconds, then local calendar dates. UI labels are “文件名时间” / “修改时间”; no guessed snowflake epoch.

`LogEntry = { timestamp: string, level: "info"|"warn"|"error", message: string }`.

`ScanProgress = { scanId: string, scanned: number, found: number, errors: number, complete: boolean, cancelled: boolean, elapsedMs: number }`.

`TaskProgress = { jobId: string, total: number, completed: number, succeeded: number, failed: number, skipped: number, cancelled: boolean, done: boolean, elapsedMs: number, currentId?: string, currentStatus?: string, reason?: string }`.

`UpdateView = { status: "idle"|"checking"|"available"|"upToDate"|"downloading"|"ready"|"error", currentVersion: string, version?: string, notes?: string, downloaded: number, total: number|null, message?: string }`.

## Commands

- `get_app_state` -> AppView
- `set_directory({kind:"input"|"output",path:string})` -> AppView
- `select_recent({kind,token})` -> AppView
- `auto_detect_input` -> AppView (safe error if none)
- `save_preferences({filters,conflictPolicy,workers,autoCheckUpdates})` -> AppView
- `scan_photos` -> scanId string; background; event `scan-progress`
- `cancel_scan` -> void
- `list_photos` -> PhotoView[] (after scan completion; virtualize in UI)
- `get_thumbnail({id})` -> string|null (data:image/jpeg;base64; 160px bounded LRU cache; background semaphore)
- `start_decryption({ids:string[]})` -> jobId string; event `task-progress`
- `cancel_decryption` -> void
- `get_logs` -> LogEntry[]
- `open_logs_directory` -> void (native open, no path returned)
- `open_output_directory` -> void (native open, no path returned)
- `export_logs({path:string})` -> void (non-overwrite; protect inputs/install)
- `export_failures({path:string})` -> void (CSV relative paths and reason codes; no absolute directories)
- `record_filter({visible:number,selected:number})` -> void (counts only)
- `check_update` -> UpdateView; event `update-progress`
- `install_update` -> void; signed install, event progress; no restart until user acknowledgement
- `restart_app` -> void

Events: `scan-progress`, `task-progress`, `app-log` (LogEntry), `update-progress` (UpdateView). Startup: get state; subscribe first; restore settings; auto-check update if opted in (offline timeout non-fatal). Selection IDs remain stable across frontend filtering. Disable directory/scan mutation while scan or decrypt runs. Decryption locks canonical paths and immutable scanned snapshot server-side, not frontend claims.
