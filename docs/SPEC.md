# Heartopia 图片解密桌面工具 — acceptance ledger

Maintainer-confirmed on 2026-11-03: standalone `HeartopiaPhotoTool`; public GitHub `heartopia-photo-tool`; preserve ScreenCapture subdirectories; skip collisions by default, optional automatic rename.

## Product and privacy contract

Windows 10/11 x64; Tauri 2 + native Rust AES-256-CBC/PKCS7; no runtime Node/Rust/Python/OpenSSL; offline application and offline WebView2 installer. No game/process/service dependency. Read-only source, atomic no-clobber output outside source, cancellation and bounded workers. Do not show absolute user paths: directory cards use basename/opaque recent IDs; manual entry is masked; native directory pickers are OS-owned. Keys and source paths stay out of logs/reports/Git. Configuration is private local user data.

Support local image libraries of varying sizes rather than assuming a fixed file count, resolution subset, or total capacity. Scanning and decryption run on background workers with bounded concurrency; virtual scrolling and on-demand thumbnails keep the interface responsive. Actual processing time and resource usage depend on the files and storage device, not a developer-host sample or a universal performance promise.

## Acceptance evidence to collect (never replace actual checks with this ledger)

1. Native AES known vector, valid padding, malformed ciphertext, decoded JPEG and PNG; read-only real sample comparison and source hashes.
2. Verified filename timestamp algorithm, tagged modification-time fallback, local-date boundaries and named date shortcuts.
3. Scan nested supported folders, extensions, cancellation, inaccessible files; large virtualized lists and bounded, on-demand thumbnails across varying library sizes.
4. Input/output traversal, canonical alias, junction/symlink, equal/nested/protected output; Chinese and >260-character paths.
5. Persistent input/output/recent/filter preferences; stable selection when filters change; individual/all/invert/filtered/clear actions.
6. Progress, cancellation, per-file continuation, conflict skip/rename; no partial output on write/decode failure; failure export.
7. Rotating safe logs, GUI log panel, log-directory open and export; sanitized errors.
8. Tauri Updater signed check/download/install/restart, timeout/failure non-fatal; current version/release notes/progress; preserved config after update.
9. Windows x64 NSIS installer embeds offline WebView2 dependency; clean Windows 10/11 install/start acceptance, not just developer-host startup.
10. README/user/architecture/build/release/CHANGELOG; functional commits/tags; accessible public repository and Release assets.

## UI direction

Quiet, dense photo workstation: warm paper background, ink text, pine primary action, amber activity, coral errors; library dominates the first screen. Directory setup above a compact filter bar; virtual table with on-demand previews and persistent checkboxes; task progress and collapsible logs at the bottom. Targets: 1280x800 and 960x700, plus large 1600x1000. Keyboard-visible focus, named controls and polite progress announcements; reduced motion. Loading/empty/error/partial/success/permission states need real rendered evidence.
