//! Native core for the Heartopia photo tool.
//!
//! Everything in this crate is independent of Tauri, the game process and the
//! network. Callers inject decryption material at runtime; real key material
//! never lives in source, tests or logs.

// One tiny, audited FFI call provides atomic no-clobber renames on Windows;
// every other module is safe Rust.
#![deny(unsafe_code)]

pub mod batch;
pub mod crypto;
pub mod date;
pub mod image_check;
pub mod output;
mod platform;
pub mod scan;
pub mod thumbnail;

pub use batch::{
    read_snapshot, run_batch, BatchRequest, BatchResult, BatchTick, FileOutcome, FileStatus,
    SourceError,
};
pub use batch::{DEFAULT_MAX_CIPHER_BYTES, MAX_WORKERS};
pub use crypto::{
    detect_image, CryptoError, CryptoMaterial, ImageFormat, DEFAULT_MAX_PLAIN_BYTES,
    MAX_PLAIN_BYTES,
};
pub use date::{
    date_from_file_name, filetime_100ns_to_unix_ms, now_unix_ms, resolve_timestamp, DateSource,
    FILETIME_UNIX_EPOCH_100NS,
};
pub use image_check::{
    decode_verified, DecodeError, MAX_DECODE_ALLOC, MAX_DECODE_EDGE, MAX_DECODE_PIXELS,
};
pub use output::{
    capture_root_of, ensure_output_allowed, is_protected_output, is_within_ci,
    validate_export_target, validate_output_target, validate_relative_path, ConflictPolicy,
    OutputError, PreparedOutput, RelativePathError, WriteOutcome,
};
pub use scan::{scan, PhotoRecord, ScanError, ScanRequest, ScanResult, ScanTick};
pub use thumbnail::{
    make_thumbnail, thumbnail_from_ciphertext, Thumbnail, ThumbnailError, THUMBNAIL_MAX_EDGE,
};
