//! Timestamp derivation.
//!
//! The project brief calls the numeric file-name prefix a "snowflake id".
//! That label may stay in UI copy, but the **verified** encoding is a Windows
//! `FILETIME`: 100 ns ticks since 1601-01-01 UTC, with no Twitter epoch and no
//! worker/sequence bit layout.
//!
//! Read-only sample comparisons support the Windows `FILETIME` encoding:
//! 100 ns ticks since 1601-01-01 UTC, with 10,000 ticks per millisecond.
//! Capture counts, date ranges and timing statistics are private test data,
//! not fixed library assumptions. No Twitter-style epoch applies.

use serde::Serialize;

/// 100 ns ticks between 1601-01-01 and 1970-01-01 (Windows FILETIME epoch).
pub const FILETIME_UNIX_EPOCH_100NS: u64 = 116_444_736_000_000_000;

/// Earlier than this the prefix is treated as noise rather than a capture time.
pub const MIN_PLAUSIBLE_MS: i64 = 1_420_070_400_000; // 2015-01-01T00:00:00Z
const FUTURE_TOLERANCE_MS: i64 = 2 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DateSource {
    /// Timestamp decoded from the FILETIME prefix embedded in the file name.
    Filetime,
    /// Fallback to the filesystem modification time.
    Modified,
}

impl DateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Filetime => "filetime",
            Self::Modified => "modified",
        }
    }
}

/// Convert FILETIME ticks to Unix milliseconds, returning `None` for values
/// that predate the Unix epoch.
pub fn filetime_100ns_to_unix_ms(ticks: u64) -> Option<i64> {
    let delta = ticks.checked_sub(FILETIME_UNIX_EPOCH_100NS)?;
    i64::try_from(delta / 10_000).ok()
}

/// Find the first maximal run of 15..=20 ASCII digits in a file stem.
///
/// Widths such as `1920_1080` are 4 digits and are ignored because the photo
/// id appears first in both supported naming schemes.
pub fn find_filetime_prefix(stem: &str) -> Option<u64> {
    let bytes = stem.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let len = i - start;
        if (15..=20).contains(&len) {
            if let Ok(text) = std::str::from_utf8(&bytes[start..i]) {
                if let Ok(value) = text.parse::<u64>() {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// Decode a plausible capture time from a file stem. `now_ms` bounds values a
/// corrupt or unrelated prefix could otherwise place in the far future.
pub fn date_from_file_name(stem: &str, now_ms: i64) -> Option<i64> {
    let ticks = find_filetime_prefix(stem)?;
    let ms = filetime_100ns_to_unix_ms(ticks)?;
    if ms < MIN_PLAUSIBLE_MS || ms > now_ms.saturating_add(FUTURE_TOLERANCE_MS) {
        return None;
    }
    Some(ms)
}

/// Resolve the effective timestamp plus its provenance.
pub fn resolve_timestamp(file_name: &str, modified_ms: i64, now_ms: i64) -> (i64, DateSource) {
    let stem = file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name);
    match date_from_file_name(stem, now_ms) {
        Some(ms) => (ms, DateSource::Filetime),
        None => (modified_ms, DateSource::Modified),
    }
}

pub fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis().min(i64::MAX as u128) as i64,
        Err(_) => 0,
    }
}

/// UTC calendar date, used by tests and logs. UI-facing `date` fields use the
/// local calendar in [`crate::scan`].
pub fn unix_ms_to_utc_ymd(ms: i64) -> (i32, u32, u32) {
    let days = ms.div_euclid(86_400_000);
    civil_from_days(days)
}

pub fn unix_ms_to_utc_hms(ms: i64) -> (u32, u32, u32, u32) {
    let rem = ms.rem_euclid(86_400_000);
    (
        (rem / 3_600_000) as u32,
        ((rem / 60_000) % 60) as u32,
        ((rem / 1_000) % 60) as u32,
        (rem % 1_000) as u32,
    )
}

/// Days since 1970-01-01 from a proleptic Gregorian date (Howard Hinnant).
pub fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = i64::from(year) - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`].
pub fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    ((y + i64::from(m <= 2)) as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filetime_for(ms: i64) -> u64 {
        FILETIME_UNIX_EPOCH_100NS + (ms as u64) * 10_000
    }

    #[test]
    fn synthetic_capture_sample_decodes_to_expected_time() {
        // Synthetic FILETIME `133000000000000000`; no real capture ID is stored.
        let stem = "133000000000000000_1920_1080";
        let ms = date_from_file_name(stem, 1_700_000_000_000).expect("plausible timestamp");
        assert_eq!(unix_ms_to_utc_ymd(ms), (2022, 6, 18));
        let (h, m, s, _) = unix_ms_to_utc_hms(ms);
        assert_eq!((h, m, s), (4, 26, 40));
        assert!((ms - 1_655_526_400_000).abs() <= 1_000);
    }

    #[test]
    fn ignores_four_digit_resolution_suffix() {
        assert_eq!(find_filetime_prefix("1920_1080"), None);
        assert_eq!(find_filetime_prefix("screenshot_20250620_152625"), None);
    }

    #[test]
    fn rejects_implausible_prefixes() {
        let now = 1_793_599_470_000i64;
        assert_eq!(date_from_file_name("123456789012345", now), None); // 1970s
        let future = filetime_for(now + 30 * 86_400_000);
        assert_eq!(
            date_from_file_name(&format!("{future}_1920_1080"), now),
            None
        );
    }

    #[test]
    fn resigns_to_mtime_when_name_has_no_id() {
        let now = 1_793_599_470_000i64;
        let (ms, src) = resolve_timestamp("holiday.jpg", 1_700_000_000_000, now);
        assert_eq!(ms, 1_700_000_000_000);
        assert_eq!(src, DateSource::Modified);
    }

    #[test]
    fn resolves_limit_style_name() {
        let now = 1_793_599_470_000i64;
        let ticks = filetime_for(1_750_433_185_190);
        let name = format!("normal+2kt6p101+Other+{ticks}.png_1564_880.jpg");
        let (ms, src) = resolve_timestamp(&name, 0, now);
        assert_eq!(src, DateSource::Filetime);
        assert_eq!(unix_ms_to_utc_ymd(ms), (2025, 6, 20));
    }

    #[test]
    fn civil_roundtrip() {
        for (y, m, d) in [(1601, 1, 1), (1970, 1, 1), (2000, 2, 29), (2025, 6, 20)] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
    }
}
