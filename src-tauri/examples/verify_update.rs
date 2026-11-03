//! Headless acceptance for the updater signature chain.
//!
//! This example builds the real Tauri application context (without running the
//! event loop, creating a window, or invoking the installer) and then uses the
//! updater plugin's own `restore_update` + `Update::verify` path against a real
//! release package. It never re-signs, installs, or modifies the package.
//!
//! Output is a single aggregate JSON object. It contains no paths, package
//! bytes, signatures, public keys, or raw error messages.
//!
//! Usage:
//!   verify_update --package <setup.exe> --signature <setup.exe.sig> --manifest <latest.json>

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tauri_plugin_updater::UpdaterExt;

struct Args {
    package: PathBuf,
    signature: PathBuf,
    manifest: PathBuf,
}

fn main() -> ExitCode {
    match run() {
        Ok(report) => {
            println!("{report}");
            ExitCode::SUCCESS
        }
        Err(code) => {
            println!("{}", json!({ "status": "fail", "code": code }));
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<Value, &'static str> {
    let args = parse_args().ok_or("usage")?;

    let package = fs::read(&args.package).map_err(|_| "package_read")?;
    if package.len() < 1024 {
        return Err("package_too_small");
    }

    let signature = read_trimmed(&args.signature).map_err(|_| "signature_read")?;
    let manifest_text = read_trimmed(&args.manifest).map_err(|_| "manifest_read")?;
    let manifest: Value = serde_json::from_str(&manifest_text).map_err(|_| "manifest_parse")?;

    // The cached signature and the manifest entry must describe the same
    // package; otherwise the negative tests would exercise the wrong artifact.
    let signature_path = manifest_signature_path(&manifest).ok_or("manifest_signature_missing")?;
    let manifest_signature = manifest
        .pointer(&signature_path)
        .and_then(Value::as_str)
        .ok_or("manifest_signature_missing")?
        .trim();
    if manifest_signature != signature {
        return Err("signature_manifest_mismatch");
    }

    // Building the app initializes the updater plugin state (config, pubkey,
    // endpoints) but does not create windows; only `run` does that.
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(tauri::generate_context!())
        .map_err(|_| "app_build")?;

    // The local package has the same version as this binary, so the default
    // "newer only" comparator would refuse to restore it. This override is
    // scoped to the acceptance example; the shipped app keeps the default.
    let updater = app
        .updater_builder()
        .version_comparator(|_, _| true)
        .build()
        .map_err(|_| "updater_build")?;

    let update = updater
        .restore_update(manifest.clone())
        .map_err(|_| "restore_valid")?
        .ok_or("valid_not_restored")?;
    update.verify(&package).map_err(|_| "valid_rejected")?;

    let tampered_signature = tamper_signature(&signature).ok_or("signature_tamper_prepare")?;
    let mut tampered_manifest = manifest.clone();
    *tampered_manifest
        .pointer_mut(&signature_path)
        .ok_or("manifest_signature_missing")? = json!(tampered_signature);
    let tampered_update = updater
        .restore_update(tampered_manifest)
        .map_err(|_| "restore_tampered_signature")?
        .ok_or("tampered_signature_not_restored")?;
    if tampered_update.verify(&package).is_ok() {
        return Err("tampered_signature_accepted");
    }

    let mut mismatched_manifest = manifest;
    mismatched_manifest["version"] = json!(negative_test_version(&update.version));
    let mismatched_update = updater
        .restore_update(mismatched_manifest)
        .map_err(|_| "restore_version_mismatch")?
        .ok_or("version_mismatch_not_restored")?;
    if mismatched_update.verify(&package).is_ok() {
        return Err("version_mismatch_accepted");
    }

    let mut tampered_package = package;
    let midpoint = tampered_package.len() / 2;
    tampered_package[midpoint] ^= 0x01;
    if update.verify(&tampered_package).is_ok() {
        return Err("tampered_package_accepted");
    }

    Ok(json!({
        "status": "pass",
        "checks": {
            "valid_package": "accepted",
            "tampered_package": "rejected",
            "tampered_signature": "rejected",
            "version_mismatch": "rejected"
        }
    }))
}

fn parse_args() -> Option<Args> {
    let mut package = None;
    let mut signature = None;
    let mut manifest = None;
    let mut args = env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let key = arg.to_str()?;
        let value = args.next()?;
        match key {
            "--package" => package = Some(PathBuf::from(value)),
            "--signature" => signature = Some(PathBuf::from(value)),
            "--manifest" => manifest = Some(PathBuf::from(value)),
            _ => return None,
        }
    }
    Some(Args {
        package: package?,
        signature: signature?,
        manifest: manifest?,
    })
}

fn read_trimmed(path: &PathBuf) -> std::io::Result<String> {
    Ok(fs::read_to_string(path)?.trim().to_owned())
}

fn negative_test_version(actual: &str) -> &'static str {
    // Build metadata does not affect SemVer precedence. Use two valid probe
    // versions so the mismatch stays real even when testing a future release
    // whose version happens to equal our first probe.
    if actual.split('+').next() == Some("0.0.0-signature-mismatch") {
        "0.0.1-signature-mismatch"
    } else {
        "0.0.0-signature-mismatch"
    }
}

fn manifest_signature_path(manifest: &Value) -> Option<String> {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;
    let platforms = manifest.get("platforms")?.as_object()?;
    for key in [format!("{os}-{arch}-nsis"), format!("{os}-{arch}")] {
        if platforms.contains_key(&key) {
            return Some(format!("/platforms/{key}/signature"));
        }
    }
    None
}

/// Re-encodes the minisign signature with one flipped byte so it still parses
/// as a signature but can no longer verify. This does not touch the private key
/// or the package; it only mutates an in-memory copy of the public `.sig` text.
fn tamper_signature(signature: &str) -> Option<String> {
    let text = String::from_utf8(STANDARD.decode(signature).ok()?).ok()?;
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    if lines.len() < 4 {
        return None;
    }

    let raw = STANDARD.decode(lines.get(1)?.trim()).ok()?;
    // minisign's signature line is `alg(2) || key id(8) || signature(64)`;
    // flipping a payload byte keeps the structure parseable.
    if raw.len() < 16 {
        return None;
    }
    let mut tampered = raw;
    tampered[10] ^= 0x01;
    lines[1] = STANDARD.encode(tampered);

    let mut rebuilt = lines.join("\n");
    if text.ends_with('\n') {
        rebuilt.push('\n');
    }
    Some(STANDARD.encode(rebuilt.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::negative_test_version;

    #[test]
    fn mismatch_probe_is_different_for_current_and_future_versions() {
        for version in [
            "0.1.0",
            "0.1.1",
            "1.2.3",
            "1.2.3-rc.1",
            "1.2.3+build.7",
            "0.0.0-signature-mismatch",
            "0.0.0-signature-mismatch+build.7",
        ] {
            assert_ne!(
                negative_test_version(version),
                version.split('+').next().unwrap(),
                "negative test must actually change the signed semantic version"
            );
        }
    }
}
