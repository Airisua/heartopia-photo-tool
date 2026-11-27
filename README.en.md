# Heartopia Photo Tool

**English** | [简体中文](README.md)

## Project Overview

Heartopia Photo Tool is a local desktop utility for Windows 10/11 x64 designed to scan and batch-decrypt encrypted screenshots from Heartopia's `ScreenCapture` directory.

It runs offline locally after installation without requiring Node.js, Rust, Python, OpenSSL, a running game client, or any external local service. Source directories remain strictly read-only, while decrypted images are written to a separate user-selected output directory via atomic temporary-file writes and skip/auto-rename collision policies.

## Disclaimer

- This is an unofficial desktop tool and is not affiliated with the game's developer or publisher.
- Only use this tool to process local screenshot files that you own or have permission to access.
- This software is provided "as is", without warranty of any kind; keeping a backup of original screenshots is recommended.

## Tech Stack

- **Desktop Framework**: Tauri 2 (Windows x64 NSIS installer, offline WebView2 runtime bundler, signed app updater)
- **Backend & Core Decryption**: Rust (native AES-256-CBC / PKCS7 decryption, background scan & bounded worker pool, path safety checks, rotating logs)
- **Frontend UI**: React 19, TypeScript, Vite, `@tanstack/react-virtual` (virtualized list), `lucide-react`
- **Testing & Quality**: Vitest, Testing Library, Cargo Test
