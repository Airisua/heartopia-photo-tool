//! Read-only scan report used to validate the core against a real tree.
//!
//! Prints aggregate counts only: no absolute paths, no key material.
//! Usage: cargo run --example scan_report -- <directory>

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

use heartopia_photo_core::{scan, DateSource, ScanRequest};

fn main() {
    let root = match std::env::args().nth(1) {
        Some(value) => value,
        None => {
            eprintln!("usage: scan_report <directory>");
            std::process::exit(2);
        }
    };
    let request = ScanRequest::new(Path::new(&root));
    let wall = Instant::now();
    let result = match scan(&request, &mut |_| {}) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("scan failed: {error}");
            std::process::exit(1);
        }
    };

    let mut per_directory: BTreeMap<&str, usize> = BTreeMap::new();
    let mut by_source = (0usize, 0usize);
    let mut bytes = 0u64;
    let mut min_date: Option<&str> = None;
    let mut max_date: Option<&str> = None;
    for record in &result.records {
        *per_directory.entry(record.directory.as_str()).or_default() += 1;
        match record.date_source {
            DateSource::Filetime => by_source.0 += 1,
            DateSource::Modified => by_source.1 += 1,
        }
        bytes = bytes.saturating_add(record.size);
        min_date = Some(min_date.map_or(record.date.as_str(), |d| d.min(record.date.as_str())));
        max_date = Some(max_date.map_or(record.date.as_str(), |d| d.max(record.date.as_str())));
    }

    println!("root_name={}", result.root_name);
    println!("output_prefix={}", result.output_prefix);
    println!("records={}", result.records.len());
    println!("entries_scanned={}", result.scanned);
    println!("errors={}", result.errors);
    println!("cancelled={}", result.cancelled);
    println!("elapsed_ms={}", result.elapsed_ms);
    println!("wall_ms={}", wall.elapsed().as_millis());
    println!("total_bytes={bytes}");
    println!("date_filetime={}", by_source.0);
    println!("date_modified={}", by_source.1);
    println!("date_min={}", min_date.unwrap_or("-"));
    println!("date_max={}", max_date.unwrap_or("-"));
    for (directory, count) in per_directory {
        println!(
            "dir={} count={count}",
            if directory.is_empty() {
                "<root>"
            } else {
                directory
            }
        );
    }
}
