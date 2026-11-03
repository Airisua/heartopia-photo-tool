//! Bounded thumbnail generation for the virtualised photo list.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{ImageError, ImageReader, Limits};
use serde::Serialize;

use crate::crypto::{CryptoError, CryptoMaterial, DEFAULT_MAX_PLAIN_BYTES};
use crate::image_check::{MAX_DECODE_ALLOC, MAX_DECODE_EDGE};

pub const THUMBNAIL_MAX_EDGE: u32 = 160;
pub const THUMBNAIL_JPEG_QUALITY: u8 = 72;
/// Hard cap for a decoded frame handed to the thumbnail path.
pub const DEFAULT_MAX_THUMBNAIL_DECODED_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    /// JPEG bytes suitable for `data:image/jpeg;base64,...`.
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum ThumbnailError {
    #[error("decryption failed: {0}")]
    Crypto(#[from] CryptoError),
    #[error("decoded frame is too large for a thumbnail")]
    TooLarge,
    #[error("image cannot be decoded")]
    Decode,
    #[error("JPEG encoding failed")]
    Encode,
}

/// Decode an already-decrypted JPEG/PNG and re-encode a bounded JPEG preview.
pub fn make_thumbnail(decoded: &[u8]) -> Result<Thumbnail, ThumbnailError> {
    if decoded.is_empty() || decoded.len() > DEFAULT_MAX_THUMBNAIL_DECODED_BYTES {
        return Err(ThumbnailError::TooLarge);
    }
    let mut reader = ImageReader::new(Cursor::new(decoded))
        .with_guessed_format()
        .map_err(|_| ThumbnailError::Decode)?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Jpeg) | Some(image::ImageFormat::Png)
    ) {
        return Err(ThumbnailError::Decode);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODE_EDGE);
    limits.max_image_height = Some(MAX_DECODE_EDGE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let image = match reader.decode() {
        Ok(image) => image,
        Err(ImageError::Limits(_)) => return Err(ThumbnailError::TooLarge),
        Err(_) => return Err(ThumbnailError::Decode),
    };
    let preview = image.thumbnail(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE);
    if preview.width() == 0 || preview.height() == 0 {
        return Err(ThumbnailError::Decode);
    }
    let (width, height) = (preview.width(), preview.height());
    let rgb = preview.to_rgb8();
    let mut jpeg = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg, THUMBNAIL_JPEG_QUALITY);
    encoder
        .encode_image(&image::DynamicImage::ImageRgb8(rgb))
        .map_err(|_| ThumbnailError::Encode)?;
    Ok(Thumbnail {
        jpeg,
        width,
        height,
    })
}

/// Convenience for preview requests: decrypt with an explicit ciphertext cap
/// and produce a bounded thumbnail. The caller controls the read size.
pub fn thumbnail_from_ciphertext(
    material: &CryptoMaterial,
    ciphertext: &[u8],
    max_cipher_bytes: u64,
) -> Result<Thumbnail, ThumbnailError> {
    if ciphertext.is_empty() {
        return Err(ThumbnailError::Decode);
    }
    if ciphertext.len() as u64 > max_cipher_bytes {
        return Err(ThumbnailError::TooLarge);
    }
    let decoded = material.decrypt(ciphertext, DEFAULT_MAX_PLAIN_BYTES)?;
    make_thumbnail(&decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::CryptoMaterial;

    #[test]
    fn encodes_a_bounded_jpeg() {
        let png = sample_png(320, 240);
        let thumbnail = make_thumbnail(&png).unwrap();
        assert_eq!((thumbnail.width, thumbnail.height), (160, 120));
        assert_eq!(&thumbnail.jpeg[..2], &[0xFF, 0xD8]);
        assert!(thumbnail.jpeg.len() < 10_000);
    }

    #[test]
    fn rejects_garbage_and_oversize() {
        assert!(matches!(
            make_thumbnail(b"not an image"),
            Err(ThumbnailError::Decode)
        ));
        let oversized = vec![0u8; DEFAULT_MAX_THUMBNAIL_DECODED_BYTES + 1];
        assert!(matches!(
            make_thumbnail(&oversized),
            Err(ThumbnailError::TooLarge)
        ));
    }

    #[test]
    fn decrypts_then_thumbnails() {
        let material = CryptoMaterial::new([3u8; 32], [4u8; 16]);
        let cipher = material.encrypt(&sample_png(64, 64)).unwrap();
        let thumbnail = thumbnail_from_ciphertext(&material, &cipher, 1024).unwrap();
        assert!(!thumbnail.jpeg.is_empty());
        assert!(matches!(
            thumbnail_from_ciphertext(&material, &cipher, 8),
            Err(ThumbnailError::TooLarge)
        ));
    }

    fn sample_png(width: u32, height: u32) -> Vec<u8> {
        let mut image = image::RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgb([(x % 256) as u8, (y % 256) as u8, 64]);
        }
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }
}
