//! Output-root validation and atomic, no-clobber writes.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_COMPONENT_BYTES: usize = 180;
const MAX_RENAME_ATTEMPTS: u32 = 1_000;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    /// Leave an existing file untouched and report the item as skipped.
    Skip,
    /// Choose the next free `name (n).ext`; never overwrites.
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RelativePathError {
    #[error("relative path is empty")]
    Empty,
    #[error("relative path is absolute or carries a drive prefix")]
    Absolute,
    #[error("relative path contains `.` or `..`")]
    Traversal,
}

#[derive(Debug, thiserror::Error)]
pub enum OutputError {
    #[error("input directory is missing")]
    InputMissing,
    #[error("input path is not a directory")]
    InputNotDirectory,
    #[error("output path is not a directory")]
    OutputNotDirectory,
    #[error("output resolves to the input directory")]
    OutputEqualsInput,
    #[error("output resolves inside the input directory")]
    OutputInsideInput,
    #[error("output is inside a protected TapTap location")]
    ProtectedOutput,
    #[error("output is inside the game ScreenCapture tree")]
    OutputInsideGameTree,
    #[error("output path contains a reparse point")]
    OutputReparse,
    #[error("destination is an existing directory")]
    DestinationIsDirectory,
    #[error("destination is inside a forbidden location")]
    ForbiddenDestination,
    #[error("relative path escapes the intended root")]
    UnsafeRelativePath,
    #[error("too many name conflicts")]
    TooManyConflicts,
    #[error("output operation failed: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WriteOutcome {
    Written {
        relative_path: String,
        renamed: bool,
    },
    Skipped,
    Cancelled,
}

/// Validate a path that will be appended to a trusted root.
pub fn validate_relative_path(path: &Path) -> Result<(), RelativePathError> {
    let mut any = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => any = true,
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => return Err(RelativePathError::Traversal),
        }
    }
    if !any {
        return Err(RelativePathError::Empty);
    }
    Ok(())
}

/// Resolve a path that may not exist yet by canonicalizing the nearest existing
/// ancestor and appending the remaining components.
pub fn canonicalize_allow_missing(path: &Path) -> io::Result<PathBuf> {
    let mut missing: Vec<OsString> = Vec::new();
    let mut cursor = path.to_path_buf();
    loop {
        match fs::canonicalize(&cursor) {
            Ok(base) => {
                let mut out = base;
                for part in missing.iter().rev() {
                    out.push(part);
                }
                return Ok(out);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name = cursor.file_name().ok_or(error)?.to_os_string();
                missing.push(name);
                if !cursor.pop() {
                    return Err(io::Error::new(
                        io::ErrorKind::NotFound,
                        "path has no existing ancestor",
                    ));
                }
            }
            Err(error) => return Err(error),
        }
    }
}

/// The user contract forbids writing anywhere under a drive-root `TapTap`
/// directory (the game install and HeartopiaDev live there).
pub fn is_protected_output(path: &Path) -> bool {
    let components: Vec<Component<'_>> = path.components().collect();
    if components.len() >= 3
        && matches!(components[0], Component::Prefix(_))
        && matches!(components[1], Component::RootDir)
    {
        if let Component::Normal(name) = components[2] {
            return name.to_string_lossy().eq_ignore_ascii_case("TapTap");
        }
    }
    false
}

fn component_eq(left: &Component<'_>, right: &Component<'_>) -> bool {
    match (left, right) {
        (Component::RootDir, Component::RootDir) => true,
        (Component::CurDir, Component::CurDir) => true,
        (Component::ParentDir, Component::ParentDir) => true,
        (Component::Prefix(a), Component::Prefix(b)) => {
            a.kind() == b.kind() && a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
        }
        (Component::Normal(a), Component::Normal(b)) => a
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy()),
        _ => false,
    }
}

/// Case-insensitive component-wise containment (Windows semantics).
pub fn is_within_ci(child: &Path, parent: &Path) -> bool {
    let mut child_components = child.components();
    for parent_component in parent.components() {
        match child_components.next() {
            Some(child_component) if component_eq(&child_component, &parent_component) => {}
            _ => return false,
        }
    }
    true
}

/// If `path` lives below a directory named `ScreenCapture`, return that root.
pub fn capture_root_of(path: &Path) -> Option<PathBuf> {
    let mut cursor = Some(path);
    while let Some(dir) = cursor {
        if let Some(name) = dir.file_name() {
            if name.to_string_lossy().eq_ignore_ascii_case("ScreenCapture") {
                return Some(dir.to_path_buf());
            }
        }
        cursor = dir.parent();
    }
    None
}

/// Reject any existing reparse point between `dir` and `stop_at` (inclusive)
/// before creating files, so a junction cannot redirect a write into the
/// original game tree.
fn ensure_no_reparse_chain(dir: &Path, stop_at: &Path) -> Result<(), OutputError> {
    let mut cursor = Some(dir);
    while let Some(current) = cursor {
        if !is_within_ci(current, stop_at) {
            break;
        }
        if let Ok(meta) = fs::symlink_metadata(current) {
            if crate::scan::is_reparse_point(&meta) {
                return Err(OutputError::OutputReparse);
            }
        }
        if current == stop_at {
            break;
        }
        cursor = current.parent();
    }
    Ok(())
}

#[derive(Debug)]
pub struct PreparedOutput {
    root: PathBuf,
    target_root: PathBuf,
    input_root: PathBuf,
    capture_root: Option<PathBuf>,
    prefix: String,
}

impl PreparedOutput {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn target_root(&self) -> &Path {
        &self.target_root
    }

    pub fn input_root(&self) -> &Path {
        &self.input_root
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// Write `bytes` to `relative` below the mirrored target root.
    pub fn write(
        &self,
        relative: &Path,
        bytes: &[u8],
        policy: ConflictPolicy,
    ) -> Result<WriteOutcome, OutputError> {
        static NEVER_CANCEL: AtomicBool = AtomicBool::new(false);
        self.write_cancellable(relative, bytes, policy, &NEVER_CANCEL)
    }

    /// Cancellable variant used by the batch runner. Cancellation is checked
    /// before any file exists, after the temporary file is synced, and before
    /// each commit attempt, so a cancelled job never publishes a file.
    pub fn write_cancellable(
        &self,
        relative: &Path,
        bytes: &[u8],
        policy: ConflictPolicy,
        cancel: &AtomicBool,
    ) -> Result<WriteOutcome, OutputError> {
        if cancel.load(Ordering::Relaxed) {
            return Ok(WriteOutcome::Cancelled);
        }
        validate_relative_path(relative).map_err(|_| OutputError::UnsafeRelativePath)?;
        let destination = self.target_root.join(relative);
        if is_within_ci(&destination, &self.input_root) {
            return Err(OutputError::OutputInsideInput);
        }
        let parent = destination
            .parent()
            .ok_or(OutputError::UnsafeRelativePath)?;
        ensure_no_reparse_chain(parent, &self.target_root)?;
        fs::create_dir_all(parent)?;
        // Re-canonicalize the immediate parent so a junction created after
        // preparation cannot redirect the write outside the target root.
        let canonical_parent = fs::canonicalize(parent)?;
        if !is_within_ci(&canonical_parent, &self.target_root) {
            return Err(OutputError::UnsafeRelativePath);
        }
        if is_within_ci(&canonical_parent, &self.input_root) {
            return Err(OutputError::OutputInsideInput);
        }
        if let Some(capture_root) = &self.capture_root {
            if is_within_ci(&canonical_parent, capture_root) {
                return Err(OutputError::OutputInsideGameTree);
            }
        }
        if let Ok(meta) = fs::symlink_metadata(&canonical_parent) {
            if crate::scan::is_reparse_point(&meta) {
                return Err(OutputError::OutputReparse);
            }
        }
        if let Ok(meta) = fs::symlink_metadata(&destination) {
            if crate::scan::is_reparse_point(&meta) {
                return Err(OutputError::OutputReparse);
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Ok(WriteOutcome::Cancelled);
        }
        let file_name = destination
            .file_name()
            .ok_or(OutputError::UnsafeRelativePath)?;
        match write_atomic_no_clobber(&canonical_parent, file_name, bytes, policy, cancel)? {
            AtomicOutcome::Skipped => Ok(WriteOutcome::Skipped),
            AtomicOutcome::Cancelled => Ok(WriteOutcome::Cancelled),
            AtomicOutcome::Written { name, renamed } => {
                let mut relative_out = PathBuf::new();
                if !self.prefix.is_empty() {
                    relative_out.push(&self.prefix);
                }
                if let Some(dir) = relative.parent() {
                    relative_out.push(dir);
                }
                relative_out.push(name);
                Ok(WriteOutcome::Written {
                    relative_path: crate::scan::display_relative(&relative_out),
                    renamed,
                })
            }
        }
    }
}

/// Validate an output directory without creating or modifying anything.
///
/// Use this for directory selection. It rejects the input tree, an input
/// ancestor that would collide with the mirror, and protected TapTap paths.
pub fn validate_output_target(
    input_root: &Path,
    output_root: &Path,
) -> Result<PathBuf, OutputError> {
    if !output_root.is_absolute() {
        return Err(OutputError::UnsafeRelativePath);
    }
    // Refuse a drive/share root: mirroring below it is never a photo folder.
    if output_root.components().count() <= 2 {
        return Err(OutputError::UnsafeRelativePath);
    }
    let input_meta = fs::metadata(input_root).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => OutputError::InputMissing,
        _ => OutputError::Io(e),
    })?;
    if !input_meta.is_dir() {
        return Err(OutputError::InputNotDirectory);
    }
    let input_canonical = fs::canonicalize(input_root)?;

    if output_root.exists() {
        let meta = fs::symlink_metadata(output_root)?;
        if crate::scan::is_reparse_point(&meta) {
            return Err(OutputError::OutputReparse);
        }
        if !meta.is_dir() {
            return Err(OutputError::OutputNotDirectory);
        }
    }
    let output_canonical = canonicalize_allow_missing(output_root)?;
    if output_canonical == input_canonical {
        return Err(OutputError::OutputEqualsInput);
    }
    if is_within_ci(&output_canonical, &input_canonical) {
        return Err(OutputError::OutputInsideInput);
    }
    if let Some(capture_root) = capture_root_of(&input_canonical) {
        if output_canonical == capture_root || is_within_ci(&output_canonical, &capture_root) {
            return Err(OutputError::OutputInsideGameTree);
        }
    }
    if is_protected_output(&output_canonical) {
        return Err(OutputError::ProtectedOutput);
    }
    Ok(output_canonical)
}

/// Validate an arbitrary export destination (logs, failure CSV).
///
/// The parent directory must already exist; nothing is created. The
/// destination must not be a directory, must not live under any forbidden
/// root (selected input, install or HeartopiaDev) and must not be inside
/// `TapTap`.
pub fn validate_export_target(
    destination: &Path,
    forbidden_roots: &[PathBuf],
) -> Result<PathBuf, OutputError> {
    if !destination.is_absolute() {
        return Err(OutputError::UnsafeRelativePath);
    }
    if destination.exists() && destination.is_dir() {
        return Err(OutputError::DestinationIsDirectory);
    }
    let parent = destination
        .parent()
        .ok_or(OutputError::UnsafeRelativePath)?;
    let file_name = destination
        .file_name()
        .ok_or(OutputError::UnsafeRelativePath)?;
    if file_name.is_empty() {
        return Err(OutputError::UnsafeRelativePath);
    }
    let parent_canonical = fs::canonicalize(parent)?;
    let canonical = parent_canonical.join(file_name);
    if is_protected_output(&canonical) {
        return Err(OutputError::ProtectedOutput);
    }
    for root in forbidden_roots {
        if let Ok(root_canonical) = fs::canonicalize(root) {
            if is_within_ci(&canonical, &root_canonical) {
                return Err(OutputError::ForbiddenDestination);
            }
        }
    }
    Ok(canonical)
}

/// Validate the input/output relationship and then create the mirrored target
/// root. Call this only when a scan or decryption is about to start.
pub fn ensure_output_allowed(
    input_root: &Path,
    output_root: &Path,
    prefix: &str,
) -> Result<PreparedOutput, OutputError> {
    let output_canonical = validate_output_target(input_root, output_root)?;
    let input_canonical = fs::canonicalize(input_root)?;
    let capture_root = capture_root_of(&input_canonical);

    let prefix_path = Path::new(prefix);
    if !prefix.is_empty() {
        validate_relative_path(prefix_path).map_err(|_| OutputError::UnsafeRelativePath)?;
    }
    let target_root = output_canonical.join(prefix_path);
    if let Some(capture_root) = &capture_root {
        if target_root == *capture_root || is_within_ci(&target_root, capture_root) {
            return Err(OutputError::OutputInsideGameTree);
        }
    }
    if target_root == input_canonical || is_within_ci(&target_root, &input_canonical) {
        return Err(OutputError::OutputInsideInput);
    }
    if let Ok(meta) = fs::symlink_metadata(&target_root) {
        if crate::scan::is_reparse_point(&meta) {
            return Err(OutputError::OutputReparse);
        }
    }
    ensure_no_reparse_chain(&target_root, &output_canonical)?;
    fs::create_dir_all(&target_root)?;
    let target_root = fs::canonicalize(&target_root)?;
    if let Some(capture_root) = &capture_root {
        if target_root == *capture_root || is_within_ci(&target_root, capture_root) {
            return Err(OutputError::OutputInsideGameTree);
        }
    }
    if target_root == input_canonical || is_within_ci(&target_root, &input_canonical) {
        return Err(OutputError::OutputInsideInput);
    }
    if is_protected_output(&target_root) {
        return Err(OutputError::ProtectedOutput);
    }
    if let Ok(meta) = fs::symlink_metadata(&target_root) {
        if crate::scan::is_reparse_point(&meta) {
            return Err(OutputError::OutputReparse);
        }
    }

    Ok(PreparedOutput {
        root: output_canonical,
        target_root,
        input_root: input_canonical,
        capture_root,
        prefix: prefix.to_string(),
    })
}

enum AtomicOutcome {
    Skipped,
    Cancelled,
    Written { name: OsString, renamed: bool },
}

fn write_atomic_no_clobber(
    dir: &Path,
    file_name: &OsStr,
    bytes: &[u8],
    policy: ConflictPolicy,
    cancel: &AtomicBool,
) -> Result<AtomicOutcome, OutputError> {
    if cancel.load(Ordering::Relaxed) {
        return Ok(AtomicOutcome::Cancelled);
    }
    let base = fit_component(file_name);
    let (temp_path, mut temp_file) = create_temp(dir)?;
    let write_result = (|| -> io::Result<()> {
        temp_file.write_all(bytes)?;
        temp_file.flush()?;
        temp_file.sync_all()?;
        Ok(())
    })();
    drop(temp_file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(OutputError::Io(error));
    }
    if cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(&temp_path);
        return Ok(AtomicOutcome::Cancelled);
    }

    for attempt in 0..MAX_RENAME_ATTEMPTS {
        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&temp_path);
            return Ok(AtomicOutcome::Cancelled);
        }
        let candidate = if attempt == 0 {
            base.clone()
        } else {
            numbered_name(&base, attempt)
        };
        let destination = dir.join(&candidate);
        match crate::platform::move_no_clobber(&temp_path, &destination) {
            Ok(()) => {
                return Ok(AtomicOutcome::Written {
                    name: candidate,
                    renamed: attempt > 0,
                })
            }
            Err(error) => {
                if destination.exists() || error.kind() == io::ErrorKind::AlreadyExists {
                    if policy == ConflictPolicy::Skip {
                        let _ = fs::remove_file(&temp_path);
                        return Ok(AtomicOutcome::Skipped);
                    }
                    continue;
                }
                let _ = fs::remove_file(&temp_path);
                return Err(OutputError::Io(error));
            }
        }
    }
    let _ = fs::remove_file(&temp_path);
    Err(OutputError::TooManyConflicts)
}

fn create_temp(dir: &Path) -> Result<(PathBuf, File), OutputError> {
    for _ in 0..128 {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!(".hdp-tmp-{}-{counter}.tmp", std::process::id());
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(OutputError::Io(error)),
        }
    }
    Err(OutputError::Io(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "temporary name space exhausted",
    )))
}

fn fit_component(name: &OsStr) -> OsString {
    if name.len() <= MAX_COMPONENT_BYTES {
        return name.to_os_string();
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = path.extension().map(|s| s.to_string_lossy().into_owned());
    let mut hasher = Sha256::new();
    hasher.update(name.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let tag: String = digest[..4].iter().map(|b| format!("{b:02x}")).collect();
    let mut short: String = stem.chars().take(100).collect();
    short.push('~');
    short.push_str(&tag);
    let mut out = OsString::from(short);
    if let Some(extension) = extension {
        out.push(".");
        out.push(extension);
    }
    out
}

fn numbered_name(base: &OsStr, attempt: u32) -> OsString {
    let path = Path::new(base);
    let stem = path.file_stem().unwrap_or(base);
    let extension = path.extension();
    let mut out = OsString::from(stem);
    out.push(format!(" ({attempt})"));
    if let Some(extension) = extension {
        out.push(".");
        out.push(extension);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("ScreenCapture").join("Photo");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("a.jpg"), b"cipher").unwrap();
        let output = temp.path().join("out");
        (temp, input, output)
    }

    #[test]
    fn rejects_equal_nested_and_traversal() {
        let (_temp, input, output) = setup();
        assert!(matches!(
            ensure_output_allowed(&input, &input, ""),
            Err(OutputError::OutputEqualsInput)
        ));
        assert!(matches!(
            ensure_output_allowed(&input, &input.join("decrypted"), ""),
            Err(OutputError::OutputInsideInput)
        ));
        assert!(ensure_output_allowed(&input, &output, "Photo").is_ok());
        assert_eq!(
            validate_relative_path(Path::new("../escape.jpg")),
            Err(RelativePathError::Traversal)
        );
        assert_eq!(
            validate_relative_path(Path::new("C:\\abs.jpg")),
            Err(RelativePathError::Traversal)
        );
    }

    #[test]
    fn write_leaves_no_partial_file_and_never_overwrites() {
        let (_temp, input, output) = setup();
        let prepared = ensure_output_allowed(&input, &output, "Photo").unwrap();
        let outcome = prepared
            .write(Path::new("frame.jpg"), b"first", ConflictPolicy::Skip)
            .unwrap();
        let first_name = match outcome {
            WriteOutcome::Written {
                relative_path,
                renamed,
            } => {
                assert!(!renamed);
                relative_path
            }
            _ => panic!("expected write"),
        };
        assert_eq!(first_name, "Photo\\frame.jpg");

        let skipped = prepared
            .write(Path::new("frame.jpg"), b"second", ConflictPolicy::Skip)
            .unwrap();
        assert!(matches!(skipped, WriteOutcome::Skipped));

        let renamed = prepared
            .write(Path::new("frame.jpg"), b"third", ConflictPolicy::Rename)
            .unwrap();
        match renamed {
            WriteOutcome::Written {
                relative_path,
                renamed,
            } => {
                assert!(renamed);
                assert_eq!(relative_path, "Photo\\frame (1).jpg");
            }
            _ => panic!("expected rename"),
        }

        let mut content = String::new();
        File::open(output.join("Photo").join("frame.jpg"))
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "first");
        let leftovers: Vec<_> = fs::read_dir(output.join("Photo"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".hdp-tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn protected_tap_tap_is_rejected() {
        assert!(is_protected_output(Path::new(
            "R:\\TapTap\\PC Games\\Heartopia"
        )));
        assert!(!is_protected_output(Path::new("R:\\Photos\\Heartopia")));
    }

    #[test]
    fn validate_only_creates_nothing() {
        let (_temp, input, output) = setup();
        let validated = validate_output_target(&input, &output).unwrap();
        assert!(!output.exists());
        assert!(validated.ends_with("out"));
        ensure_output_allowed(&input, &output, "Photo").unwrap();
        assert!(output.join("Photo").is_dir());
    }

    #[test]
    fn export_guard_rejects_input_and_directories() {
        let (temp, input, _output) = setup();
        let forbidden = vec![input.clone()];
        let inside = input.join("export.csv");
        assert!(matches!(
            validate_export_target(&inside, &forbidden),
            Err(OutputError::ForbiddenDestination)
        ));
        let elsewhere = temp.path().join("export.csv");
        let validated = validate_export_target(&elsewhere, &forbidden).unwrap();
        assert!(validated.ends_with("export.csv"));
        let folder = temp.path().join("folder");
        fs::create_dir_all(&folder).unwrap();
        assert!(matches!(
            validate_export_target(&folder, &forbidden),
            Err(OutputError::DestinationIsDirectory)
        ));
    }

    #[test]
    fn long_names_are_still_writable() {
        let (_temp, input, output) = setup();
        let prepared = ensure_output_allowed(&input, &output, "").unwrap();
        let long = format!("{}.jpg", "a".repeat(300));
        let outcome = prepared
            .write(Path::new(&long), b"x", ConflictPolicy::Skip)
            .unwrap();
        match outcome {
            WriteOutcome::Written { relative_path, .. } => {
                assert!(relative_path.len() < 260);
            }
            _ => panic!("expected write"),
        }
    }

    #[test]
    fn writes_deep_relative_paths() {
        let (_temp, input, output) = setup();
        let prepared = ensure_output_allowed(&input, &output, "").unwrap();
        let mut deep = String::new();
        for index in 0..8 {
            deep.push_str(&format!("深层目录-{index}-{}\\", "y".repeat(18)));
        }
        assert!(deep.len() > 260);
        let relative = format!("{deep}结果.jpg");
        let outcome = prepared
            .write(Path::new(&relative), b"deep", ConflictPolicy::Skip)
            .unwrap();
        assert!(matches!(outcome, WriteOutcome::Written { .. }));
        assert!(output.join(&relative).exists());
    }

    #[test]
    fn rejects_relative_and_game_tree_outputs_without_creating() {
        let (temp, input, _output) = setup();
        assert!(matches!(
            validate_output_target(&input, Path::new("relative\\out")),
            Err(OutputError::UnsafeRelativePath)
        ));
        let capture = temp.path().join("ScreenCapture");
        assert!(matches!(
            validate_output_target(&input, &capture),
            Err(OutputError::OutputInsideGameTree)
        ));
        let inside = capture.join("Decrypted");
        assert!(matches!(
            validate_output_target(&input, &inside),
            Err(OutputError::OutputInsideGameTree)
        ));
        assert!(!inside.exists());
        let sibling = temp.path().join("out2");
        assert!(validate_output_target(&input, &sibling).is_ok());
        assert!(!sibling.exists());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_reparse_output_root() {
        use std::process::Command;
        let (temp, input, _output) = setup();
        let real = temp.path().join("real_out");
        fs::create_dir_all(&real).unwrap();
        let link = temp.path().join("link_out");
        let status = Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &real.to_string_lossy(),
            ])
            .status()
            .expect("cmd available");
        if !status.success() {
            eprintln!("junction creation unavailable on this host; skipping");
            return;
        }
        assert!(matches!(
            validate_output_target(&input, &link),
            Err(OutputError::OutputReparse)
        ));
    }

    #[test]
    fn cancelled_write_publishes_nothing() {
        let (_temp, input, output) = setup();
        let prepared = ensure_output_allowed(&input, &output, "").unwrap();
        let cancel = AtomicBool::new(true);
        let outcome = prepared
            .write_cancellable(
                Path::new("cancelled.jpg"),
                b"data",
                ConflictPolicy::Skip,
                &cancel,
            )
            .unwrap();
        assert!(matches!(outcome, WriteOutcome::Cancelled));
        assert!(!output.join("cancelled.jpg").exists());
    }

    #[test]
    fn existing_hardlink_to_original_is_never_overwritten() {
        let (_temp, input, output) = setup();
        let prepared = ensure_output_allowed(&input, &output, "").unwrap();
        let original = input.join("a.jpg");
        let destination = output.join("taken.jpg");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::hard_link(&original, &destination).unwrap();
        let before = fs::read(&original).unwrap();

        let skipped = prepared
            .write(Path::new("taken.jpg"), b"replacement", ConflictPolicy::Skip)
            .unwrap();
        assert!(matches!(skipped, WriteOutcome::Skipped));
        assert_eq!(fs::read(&original).unwrap(), before);
        assert_eq!(fs::read(&destination).unwrap(), before);

        let renamed = prepared
            .write(
                Path::new("taken.jpg"),
                b"replacement",
                ConflictPolicy::Rename,
            )
            .unwrap();
        assert!(matches!(
            renamed,
            WriteOutcome::Written { renamed: true, .. }
        ));
        assert_eq!(fs::read(&original).unwrap(), before);
        assert_eq!(fs::read(&destination).unwrap(), before);
    }
}
