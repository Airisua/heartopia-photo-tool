# Heartopia Photo Tool

**English** | [简体中文](README.md)

A local desktop tool for Windows 10/11 x64 that restores encrypted screenshots from Heartopia's `ScreenCapture` directory in batches. Built with Tauri 2, native Rust AES-256-CBC/PKCS7 decryption, and React. Once installed, it does not require Node.js, Rust, Python, OpenSSL, a running game, or any local server.

[Windows installer](https://github.com/Airisua/heartopia-photo-tool/releases) · [User guide](docs/USAGE.en.md) · [Changelog (Chinese)](CHANGELOG.md)

> `0.1.0` is the first desktop test release. The installer is available on GitHub Releases. Acceptance testing on clean Windows 10/11 systems and end-to-end updates between released versions is not yet complete.

> This is an unofficial tool, not affiliated with the game's developer or publisher. Only process local files that you have permission to access.

> The application interface is currently in Simplified Chinese. This README and the linked user guide provide English documentation; they do not add an English interface.

## Features

- Detects the default `LocalLow\xd\心动小镇\ScreenCapture` directory, with manual selection of the root or a subdirectory such as `Photo` or `Draw`.
- Recursively scans supported image files, including those in `Photo`, `Limit`, `Draw`, `NoBgPhoto`, and `Announcement`.
- Filters by directory, JPG/PNG file type, keyword, or date range, with Today, Last 7 Days, Last 30 Days, and All shortcuts. Dates are parsed from Windows FILETIME values in filenames where possible; otherwise, the file's modification time is used. The date source is shown in the list.
- Uses a virtualized list and on-demand thumbnail loading rather than creating a large number of DOM elements at startup.
- Runs scanning and decryption on background threads, with bounded concurrency and caches. Processing time depends on the number and size of images and the storage device; no fixed library size or processing-time guarantee is assumed.
- Supports individual selection, select all, invert selection, select all filtered results, and clear selection. Changing a filter preserves previously selected items, including those no longer visible.
- Provides batch decryption, progress reporting, cancellation, continued processing after individual file failures, and failure-list export.
- Skips existing output files by default, with an optional automatic rename policy. Existing files are never overwritten.
- Writes each output to a temporary file before an atomic, no-overwrite rename. Failed or cancelled writes are cleaned up instead of leaving partial images.
- Includes an in-app log panel, rotating log files, an action to open the log folder, and log export.
- Supports startup and manual update checks, download progress, signature verification, installation, and restart. An update failure does not stop the current version from working.
- Updates replace the installed desktop application after restart; code is not replaced while the application is running.
- Keeps source files read-only and rejects output directories that equal or sit inside the input directory. Filesystem checks also reject symbolic links, junctions, path aliases, and writes to protected directories.

## Quick start

1. Download the `*-setup.exe` installer from [the latest release](https://github.com/Airisua/heartopia-photo-tool/releases/latest). Compare its SHA-256 checksum with the release's `SHA256SUMS.txt` before installing.
2. Select the `ScreenCapture` root or one of its subdirectories, then choose a separate output directory outside the input tree.
3. Scan, apply any desired filters, select images, and start decryption.
4. Open the output images with a normal image viewer. Your input directory remains unchanged.

Input and output directories, recent locations, and filter preferences are saved locally and restored when the application is reopened. See the [English user guide](docs/USAGE.en.md) for the Chinese button labels, selection behavior, collision policies, logs, and troubleshooting.

The installer bundles the WebView2 offline installer and installs the runtime if it is missing. An internet connection is not needed for this step. This packaging configuration is in place; actual clean-system installation remains part of the pending acceptance tests.

## Privacy and safety boundaries

- Source images are read-only: the tool does not modify, move, or delete them.
- Decrypted images are written only to the output directory you choose. Existing output files are not overwritten.
- The interface displays only directory basenames and recent-location aliases; manual path fields are masked. Logs and exported failure lists do not contain full user-directory paths.
- Real paths are stored in the local configuration so that directories can be restored after restart. Path masking is not configuration-file encryption; do not publish your configuration files or private screenshots.
- Game-format AES material is injected at build time and is not displayed, logged, or committed to source control. It is distributed within the binary and cannot be kept secret from someone reverse-engineering that binary locally.
- Image processing works offline. Only update checks and downloads require network access, and automatic checks can be disabled.

For implementation details, see the [architecture](docs/ARCHITECTURE.md) and [security notes](docs/SECURITY.md), currently in Chinese.

## System requirements

- Windows 10 22H2 x64 or Windows 11 x64.
- An x64 NSIS installer, with per-user installation by default.
- No preinstalled Node.js, Rust, Python, OpenSSL, or game client is required.
- WebView2 is required by the interface; the installer includes its offline runtime installer.

## Developer documentation

The following documents are for contributors and maintainers, **not additional installation steps or proof that all acceptance tests have passed**. End users only need the release installer and user guide.

<details>
<summary>Source builds, architecture, and release workflow (Chinese documentation)</summary>

Building from source requires Node.js 22, stable Rust with the MSVC toolchain, Visual Studio C++ Build Tools, and WebView2. Release builds additionally require privately supplied game-format AES material and an updater signing key; neither is included in the public repository.

```powershell
npm ci
npm run tauri dev
```

Tests, installer packaging, offline WebView2, signed updates, and clean-system acceptance procedures are documented in the following Chinese guides:

- [Architecture](docs/ARCHITECTURE.md)
- [Build guide](docs/BUILD.md)
- [Maintainer packaging and release workflow](docs/RELEASE.md)
- [Acceptance ledger](docs/ACCEPTANCE.md)
- [Clean Windows test procedure](docs/CLEAN_MACHINE.md)
- [Security and privacy](docs/SECURITY.md)
- [Security reporting policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

</details>

## Acceptance status

The [acceptance ledger](docs/ACCEPTANCE.md) tracks functionality, performance, clean Windows installation, and the planned `0.1.0` → `0.1.1` update test. Items without sufficient evidence remain unverified. Passing unit tests, building an installer, or launching on a development machine does not establish that clean-system installation or a complete update cycle has passed.

The `0.1.0` installer is published; clean Windows 10/11 installation and cross-version update acceptance remain incomplete. Consult the ledger for individual test statuses and outstanding steps.

## License

[MIT](LICENSE)
