//! Strict bounded decode used before committing any output file.
//!
//! Header checks alone cannot prove that a decrypted payload is a complete
//! image: a truncated frame can keep a valid SOI/IHDR. Every batch item is
//! therefore fully decoded once with hard memory and dimension limits.

use std::io::Cursor;

use image::{ImageError, ImageReader, Limits};

use crate::crypto::{image_dimensions, ImageFormat};

pub const MAX_DECODE_EDGE: u32 = 16_384;
pub const MAX_DECODE_PIXELS: u64 = 64_000_000;
pub const MAX_DECODE_ALLOC: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    #[error("image is corrupt or unsupported")]
    Corrupt,
    #[error("image exceeds decode limits")]
    TooLarge,
}

/// Fully decode a JPEG/PNG and return its format. Any failure means the frame
/// must not be written: callers report `not_image` and keep the batch going.
pub fn decode_verified(bytes: &[u8]) -> Result<ImageFormat, DecodeError> {
    let (format, (width, height)) = image_dimensions(bytes).ok_or(DecodeError::Corrupt)?;
    if u64::from(width) * u64::from(height) > MAX_DECODE_PIXELS {
        return Err(DecodeError::TooLarge);
    }
    let image_format = match format {
        ImageFormat::Jpeg => image::ImageFormat::Jpeg,
        ImageFormat::Png => image::ImageFormat::Png,
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), image_format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODE_EDGE);
    limits.max_image_height = Some(MAX_DECODE_EDGE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let decoded = match reader.decode() {
        Ok(image) => image,
        Err(ImageError::Limits(_)) => return Err(DecodeError::TooLarge),
        Err(_) => return Err(DecodeError::Corrupt),
    };
    if decoded.width() != width || decoded.height() != height {
        return Err(DecodeError::Corrupt);
    }
    Ok(format)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([12, 34, 56]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }

    fn sample_jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([200, 10, 90]));
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .unwrap();
        jpeg
    }

    #[test]
    fn accepts_complete_images() {
        assert_eq!(decode_verified(&sample_png(4, 3)), Ok(ImageFormat::Png));
        assert_eq!(decode_verified(&sample_jpeg(5, 2)), Ok(ImageFormat::Jpeg));
    }

    #[test]
    fn rejects_truncated_payload_with_valid_header() {
        let png = sample_png(8, 8);
        // Remove the trailing IEND chunk: the header is still valid.
        let truncated = &png[..png.len() - 12];
        assert_eq!(decode_verified(truncated), Err(DecodeError::Corrupt));
    }

    #[test]
    fn rejects_corrupt_pixel_data_with_valid_header() {
        let mut png = sample_png(8, 8);
        let position = png.windows(4).position(|w| w == b"IDAT").unwrap();
        png[position + 4] ^= 0xFF;
        assert_eq!(decode_verified(&png), Err(DecodeError::Corrupt));
    }

    #[test]
    fn rejects_non_images() {
        assert_eq!(decode_verified(b"plain text"), Err(DecodeError::Corrupt));
    }
}
