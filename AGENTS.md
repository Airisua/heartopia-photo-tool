# Project boundaries

- This is a standalone project. Write only inside this repository and its chosen test/output directories.
- Never modify TapTap, the Heartopia installation, or HeartopiaDev. Read existing reverse-engineering evidence only when needed.
- Inputs are strictly read-only. Output must be outside the input tree. Never overwrite an existing output; use skip or atomic no-clobber rename.
- Reject path traversal, symlinks/junctions/reparse points and source aliases at filesystem boundaries.
- Never expose keys, credentials, or absolute user directories in application UI, events, error messages, logs, reports, or Git history.
- Keep build-only secrets in ignored `.secrets/` / environment variables. Public test vectors must use synthetic keys.
- Workers share this checkout. Do not revert others' changes; respect assigned ownership.
- Structural exploration follows the installed codebase-memory skill; check coverage and use direct source fallback where excluded/unindexed.
- Use Chinese user-facing copy. Test changes, document actual evidence, and do not claim clean-machine or update acceptance without real verification.

# Implementation lanes

- Rust core: `crates/photo-core/` (crypto, dates, scan, safe output, bounded batch, unit tests).
- UI: `src/`, `index.html` (React/TypeScript, virtual list, selection/filter/config/task/log/update UI).
- Release/docs: `docs/` except `IPC.md` and `SPEC.md`, `.github/`, `scripts/` except root-owned local secret/auth helpers.
- Root integration: scaffold, `src-tauri/`, dependency locks, private fixtures, final verification and publishing.
