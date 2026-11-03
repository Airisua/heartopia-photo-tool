//! Platform primitives that std does not expose safely.

// `std::fs::rename` replaces an existing destination on Windows (it uses
// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`), which would silently
// overwrite user files. This module performs the same move *without* that flag
// so an existing destination makes the call fail with `AlreadyExists`.
#![allow(unsafe_code)]

use std::io;
use std::path::Path;

#[cfg(windows)]
pub(crate) fn move_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    let from = wide(from);
    let to = wide(to);
    let result = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Portable fallback: a hard link fails when the destination exists, then the
/// temporary name is removed.
#[cfg(not(windows))]
pub(crate) fn move_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::hard_link(from, to)?;
    std::fs::remove_file(from)
}

/// Resolve the canonical path behind an open handle. This defeats a reparse
/// point swapped into the parent chain after the scan.
#[cfg(windows)]
pub(crate) fn final_path_of(
    file: &std::fs::File,
    _fallback: &Path,
) -> io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let handle = file.as_raw_handle();
    let mut capacity = 512u32;
    loop {
        let mut buffer = vec![0u16; capacity as usize];
        let len =
            unsafe { GetFinalPathNameByHandleW(handle as _, buffer.as_mut_ptr(), capacity, 0) };
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        if len < capacity {
            let path = std::ffi::OsString::from_wide(&buffer[..len as usize]);
            return Ok(std::path::PathBuf::from(path));
        }
        capacity = len.saturating_add(1);
        if capacity > 65_536 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "final path is too long",
            ));
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn final_path_of(
    _file: &std::fs::File,
    fallback: &Path,
) -> io::Result<std::path::PathBuf> {
    std::fs::canonicalize(fallback)
}
