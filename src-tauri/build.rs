use base64::{engine::general_purpose::STANDARD, Engine};
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=HEARTOPIA_CRYPTO_MATERIAL_B64");
    println!("cargo:rerun-if-env-changed=HEARTOPIA_RELEASE");
    let material = env::var("HEARTOPIA_CRYPTO_MATERIAL_B64").ok().map(|value| {
        STANDARD
            .decode(value.trim())
            .expect("Invalid build-only crypto material")
    });
    if material.as_ref().is_some_and(|bytes| bytes.len() != 48) {
        panic!("Build-only crypto material must contain exactly 48 bytes");
    }
    if env::var("HEARTOPIA_RELEASE").as_deref() == Ok("1") && material.is_none() {
        panic!("Release builds require build-only crypto material");
    }
    let available = material.is_some();
    let bytes = material.unwrap_or_else(|| vec![0; 48]);
    let generated = format!(
        "pub const KEY_AVAILABLE: bool = {available};\npub const KEY_BYTES: [u8; 32] = {:?};\npub const IV_BYTES: [u8; 16] = {:?};\n",
        &bytes[..32], &bytes[32..]
    );
    // Secret values are only in ignored compiler output, never in cargo directives/logs.
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Missing build output directory"));
    fs::write(output.join("crypto_material.rs"), generated).expect("Cannot prepare build material");
    tauri_build::build();
}
