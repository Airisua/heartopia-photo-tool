# User Guide

**English** | [简体中文](USAGE.md)

> The application UI is currently in Simplified Chinese. This guide is written in English, but the interface itself has not been localized. Chinese control labels are quoted with an English explanation so you can follow the screens.

Release status: `v0.1.0` is published on [GitHub Releases](https://github.com/Airisua/heartopia-photo-tool/releases/tag/v0.1.0). Clean Windows installation and the `0.1.0` to `0.1.1` update path are still pending real acceptance evidence; see the [acceptance ledger](ACCEPTANCE.md). A published installer is not proof that those checks have passed.

Unofficial tool. Process only files you are authorized to access.

## 1. Scope

This tool converts encrypted screenshots from the game client's `ScreenCapture` directory into JPG/PNG files that open normally. It reads only the source directory you select. Decrypted files are written only to a separate output directory.

Supported systems are Windows 10/11 x64. The installer includes an offline WebView2 installer, so no Node.js, Rust, Python, or OpenSSL installation is required. You do not need to start the game or any local service.

> The input and output directories cannot be the same, and the output cannot be located inside the input. The tool rejects these settings.

## 2. First Use

1. Start the application. If the default game image directory exists, the application tries to detect `ScreenCapture` automatically.
2. Confirm the **输入目录** (Input directory). You can click **选择目录** (Choose directory), or expand **最近使用** (Recent) and select a previous directory.
3. Choose the **输出目录** (Output directory). Use an independent empty directory outside the source tree; this guide refers to it as `<OUTPUT_DIR>`.
4. Click **扫描图片** (Scan images).

Scanning runs on a background thread. You can browse the interface and cancel while it runs. Canceling keeps the files already discovered and never deletes anything. Do not change the input or output directory while a scan or decryption job is active; wait until the job finishes or is canceled.

The interface shows only the final component of each directory path and aliases for recent directories; manual path entry is masked. Full paths appear only in local configuration and the native file picker, and are not written to logs, failure lists, or the interface.

### Input Levels

- `ScreenCapture` root: recursively scans subdirectories such as `Photo`, `Limit`, `Draw`, `NoBgPhoto`, and `Announcement`.
- A single subdirectory: for example, select only `Photo` or `Draw`. The output preserves that relative hierarchy for easier filing.

Only `.jpg`, `.jpeg`, and `.png` files are scanned. The extension check is case-insensitive. Other files do not enter the list.

## 3. Filtering and Dates

The list shows the file name and relative path (including its directory), capture time, size, date source, and processing status. Use the Type filter to narrow the list to JPG or PNG.

Available filters:

- Directory: filter by relative directory.
- Type: filter by JPG/PNG.
- Date: **全部** (All), **今天** (Today), **近 7 天** (Last 7 days), **近 30 天** (Last 30 days), or **自定义** (Custom) with a start and end date.
- File name or path keyword.

Dates are derived first from the image ID embedded in the file name. That ID has been validated as a **Windows FILETIME** value (100-nanosecond ticks since 1601-01-01 UTC), not a Snowflake/Twitter timestamp. If the value cannot be parsed or is outside a plausible range, the application falls back to the file modification time. The **日期来源** (Date source) column shows **文件名时间** (Filename time) or **修改时间** (Modified time). Dates use the local time zone, and a custom start and end date both include the whole day. Changing filters does not clear selections. The footer shows how many photos match the current filter and how many are selected.

## 4. Selecting Images

Each row has a checkbox on the left. The controls are:

- Select individual rows or multiple rows.
- **全选全部** (Select all scanned): select every photo in the current scan.
- **反选全部** (Invert all scanned): invert the selection across the whole scan.
- **全选结果** (Select current results): select the photos matching the current filter.
- **反选** (Invert current results): invert the selection within the current filter.
- **清空** (Clear): clear all selections.

Selection is keyed to a stable image ID and is retained when filters change. The selection bar shows the total selected count and, when applicable, how many selected photos are outside the current filter. Decryption processes the **entire current selection**, including selected photos hidden by the active filter. Check the pending count before starting if you only want the visible subset.

> The same scene may be saved at several resolutions. Use the width and height suffix in the file name as a search keyword to process only the versions you need and avoid duplicate decryption.

## 5. Batch Decryption

1. Select the photos you want.
2. Choose a policy under **重名文件** (Existing files):
   - **跳过** (Skip), the default: skip when a file with the same name already exists. Never overwrite.
   - **自动重命名** (Auto rename): create a new name such as `name (1).jpg`. Never overwrite an existing file.
3. Choose a concurrency value from 1 to 8. For a mechanical hard drive, 2 to 4 is a reasonable starting point; an SSD can usually handle more.
4. Click the primary button labeled **解密 N 张** (Decrypt N images).

Output preserves the source directory hierarchy by default and uses the correct `.jpg` or `.png` extension based on the decrypted file signature. Each file is written to a temporary file in the same directory, flushed, and then atomically renamed. A failure or cancellation removes the temporary file, so no partial output is left behind.

A single file failure does not stop the batch. The reason appears in the row and in the log. After the job finishes, you can export a failure list (CSV) containing relative paths and reason codes only; it does not contain the full user directory.

### Cancel and Exit

- Click **取消任务** (Cancel task) to stop starting new files. A file already being written is allowed to finish or clean up before the job stops.
- Do not disconnect or remove the disk containing the output directory during a scan or decryption job. Cancel the job before exiting.
- Exiting the application does not delete files that were already written successfully.

## 6. Logs

The log panel at the bottom shows scan, filter, decryption, failure, and update events for the current session. Events are also written to the local log directory and rotated by size.

- **打开日志目录** (Open log folder) opens the folder in the system file manager without showing the path in the interface.
- **导出日志** (Export log) saves a text file. An existing target is not overwritten.
- Logs do not contain keys, full source or output directories, or image content.

## 7. Checking for Updates

The application can check for updates at startup according to your setting, or you can click **检查更新** (Check for updates) manually.

1. When a new version exists, the application shows its version, release notes, and download progress.
2. After download, the installer is verified against its signature.
3. When prompted, click **重启并完成更新** (Restart and finish update) to complete the update. User configuration, recent directories, and filter preferences are preserved.
4. A failed check, network outage, or unavailable update server does not affect the current version.

In this guide, "hot update" means a desktop application version update. It does not replace program code while the application is running.

## 8. Troubleshooting

**The scan finds zero files**

- Confirm that you selected `ScreenCapture` or one of its subdirectories. The tool does not guess when an unrelated directory is selected.
- Confirm that the files use `.jpg`, `.jpeg`, or `.png`.
- If the directory is locked by the game or permissions are insufficient, the log records how many entries were skipped.

**A decrypted image does not open**

- Only encrypted screenshots generated by the game can be restored. Files modified or truncated by another tool will fail.
- Check the reason code in the failure list and keep the original file for reproduction.

**The output directory is rejected**

- The output directory cannot equal the input directory or be located inside it.
- The tool does not allow writing to the game installation directory or other protected locations.
- An output directory that aliases the input through a symbolic link or junction is also rejected.

**A Chinese or very long path fails**

- The tool handles Chinese directory names as Unicode paths and never rewrites source file names.
- If the output path exceeds system limits, shorten the output root or enable Windows long-path support. Failures are recorded in the log and failure list without leaving partial files.

**The application does not start after installation**

- The installer includes an offline WebView2 installer. If system policy blocks installation, ask an administrator to allow the Microsoft Edge WebView2 Runtime.
- Windows 10 must be x64 and have current system updates. 32-bit systems are not supported.

**Antivirus software blocks the application**

- A build without a code-signing certificate may trigger a SmartScreen warning. Verify the SHA-256 and signature published on the Release page, and do not download from third-party mirror sites.

## 9. Data and Privacy

- Source images are read-only. The tool does not modify, move, or delete them.
- Output is written only to the output directory you select.
- Configuration is stored in the local Tauri configuration directory. Recent directories are stored as opaque aliases and shown by alias in the interface.
- Logs and failure lists are path-redacted.
- Decryption material is injected only at build time. It is not shown in the interface, written to logs, or committed to Git. A published binary may still be extracted by a capable local reverse engineer; it exists for format compatibility and must not be treated as an additional access-control mechanism.
- Image processing works offline. Only update checks and downloads require network access, and automatic checks can be disabled.

## Related Documentation

The detailed maintainer and acceptance documents are currently in Chinese:

- [English README](../README.en.md)
- [Chinese user guide](USAGE.md)
- [Architecture](ARCHITECTURE.md)
- [Build instructions](BUILD.md)
- [Release process](RELEASE.md)
- [Acceptance ledger](ACCEPTANCE.md)
- [Security and privacy](SECURITY.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)
