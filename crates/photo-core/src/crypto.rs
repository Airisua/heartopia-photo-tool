//! AES-256-CBC + PKCS7 with runtime-injected material.

use std::fmt;

use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use zeroize::Zeroizing;

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// Upper bound for a decoded frame. Game frames are ~1 MiB; this is only a
/// guard against a maliciously crafted ciphertext expanding unexpectedly.
pub const DEFAULT_MAX_PLAIN_BYTES: usize = 32 * 1024 * 1024;
/// Hard ceiling applied by the batch runner regardless of caller settings.
/// Eight workers therefore stay below roughly 512 MiB of transient buffers.
pub const MAX_PLAIN_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    #[error("ciphertext is empty")]
    Empty,
    #[error("ciphertext length is not a multiple of the AES block size")]
    NotBlockAligned,
    #[error("decoded frame exceeds the configured limit")]
    TooLarge,
    #[error("ciphertext is not valid PKCS7 for this key")]
    BadPadding,
    #[error("decryption material has an invalid length")]
    BadMaterialLength,
}

/// Decryption material supplied at runtime by the integration layer.
///
/// The `Debug` implementation never prints key or IV bytes.
pub struct CryptoMaterial {
    key: Zeroizing<[u8; 32]>,
    iv: Zeroizing<[u8; 16]>,
}

impl CryptoMaterial {
    pub fn new(key: [u8; 32], iv: [u8; 16]) -> Self {
        Self {
            key: Zeroizing::new(key),
            iv: Zeroizing::new(iv),
        }
    }

    pub fn from_slices(key: &[u8], iv: &[u8]) -> Result<Self, CryptoError> {
        if key.len() != 32 || iv.len() != 16 {
            return Err(CryptoError::BadMaterialLength);
        }
        let mut k = [0u8; 32];
        let mut i = [0u8; 16];
        k.copy_from_slice(key);
        i.copy_from_slice(iv);
        Ok(Self::new(k, i))
    }

    /// Encrypt with PKCS7. Exposed for synthetic test vectors and self-checks
    /// only; production paths never encrypt user files.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let enc = Aes256CbcEnc::new_from_slices(&self.key[..], &self.iv[..])
            .map_err(|_| CryptoError::BadMaterialLength)?;
        Ok(enc.encrypt_padded_vec_mut::<Pkcs7>(plaintext))
    }

    pub fn decrypt(
        &self,
        ciphertext: &[u8],
        max_plain_bytes: usize,
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        if ciphertext.is_empty() {
            return Err(CryptoError::Empty);
        }
        if ciphertext.len() % 16 != 0 {
            return Err(CryptoError::NotBlockAligned);
        }
        if ciphertext.len().saturating_sub(16) > max_plain_bytes {
            return Err(CryptoError::TooLarge);
        }
        let dec = Aes256CbcDec::new_from_slices(&self.key[..], &self.iv[..])
            .map_err(|_| CryptoError::BadMaterialLength)?;
        let plain = dec
            .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
            .map_err(|_| CryptoError::BadPadding)?;
        if plain.len() > max_plain_bytes {
            return Err(CryptoError::TooLarge);
        }
        Ok(Zeroizing::new(plain))
    }
}

impl fmt::Debug for CryptoMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CryptoMaterial")
            .field("key", &"<redacted>")
            .field("iv", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpeg,
    Png,
}

impl ImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
        }
    }
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Structural image detection. A decrypted frame must be one of the formats
/// the game actually writes, so an unexpected payload is reported as an error
/// instead of being written with a misleading extension. Header parsing
/// (JPEG SOF / PNG IHDR) is cheap and rejects valid-padding garbage without
/// decoding the full frame.
pub fn detect_image(bytes: &[u8]) -> Option<ImageFormat> {
    image_dimensions(bytes).map(|(format, _)| format)
}

/// Cheap header parse returning both the format and declared dimensions.
pub(crate) fn image_dimensions(bytes: &[u8]) -> Option<(ImageFormat, (u32, u32))> {
    let format = if bytes.len() >= 8 && bytes[..8] == PNG_SIGNATURE {
        let tail = &bytes[bytes.len().saturating_sub(32)..];
        let has_iend = tail.windows(4).any(|w| w == b"IEND");
        if !has_iend {
            return None;
        }
        ImageFormat::Png
    } else if bytes.len() >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        let len = bytes.len();
        let tail_start = len.saturating_sub(64);
        let eoi_at_end = bytes[len - 2] == 0xFF && bytes[len - 1] == 0xD9;
        let eoi_near_end = bytes[tail_start..].windows(2).any(|w| w == [0xFF, 0xD9]);
        if !(eoi_at_end || eoi_near_end) {
            return None;
        }
        ImageFormat::Jpeg
    } else {
        return None;
    };
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width == 0 || height == 0 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE {
        return None;
    }
    Some((format, (width, height)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic material only. Never replace with the real game material.
    fn material() -> CryptoMaterial {
        let key: [u8; 32] = [
            0x60, 0x3d, 0xeb, 0x10, 0x15, 0xca, 0x71, 0xbe, 0x2b, 0x73, 0xae, 0xf0, 0x85, 0x7d,
            0x77, 0x81, 0x1f, 0x35, 0x2c, 0x07, 0x3b, 0x61, 0x08, 0xd7, 0x2d, 0x98, 0x10, 0xa3,
            0x09, 0x14, 0xdf, 0xf4,
        ];
        let iv: [u8; 16] = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f,
        ];
        CryptoMaterial::new(key, iv)
    }

    const NIST_PLAINTEXT: [u8; 64] = [
        0x6b, 0xc1, 0xbe, 0xe2, 0x2e, 0x40, 0x9f, 0x96, 0xe9, 0x3d, 0x7e, 0x11, 0x73, 0x93, 0x17,
        0x2a, 0xae, 0x2d, 0x8a, 0x57, 0x1e, 0x03, 0xac, 0x9c, 0x9e, 0xb7, 0x6f, 0xac, 0x45, 0xaf,
        0x8e, 0x51, 0x30, 0xc8, 0x1c, 0x46, 0xa3, 0x5c, 0xe4, 0x11, 0xe5, 0xfb, 0xc1, 0x19, 0x1a,
        0x0a, 0x52, 0xef, 0xf6, 0x9f, 0x24, 0x45, 0xdf, 0x4f, 0x9b, 0x17, 0xad, 0x2b, 0x41, 0x7b,
        0xe6, 0x6c, 0x37, 0x10,
    ];
    /// First cipher block of the NIST SP 800-38A AES-256-CBC vector.
    const NIST_FIRST_BLOCK: [u8; 16] = [
        0xf5, 0x8c, 0x4c, 0x04, 0xd6, 0xe5, 0xf1, 0xba, 0x77, 0x9e, 0xab, 0xfb, 0x5f, 0x7b, 0xfb,
        0xd6,
    ];

    #[test]
    fn decrypts_nist_vector_first_block() {
        let enc = material().encrypt(&NIST_PLAINTEXT).unwrap();
        assert_eq!(&enc[..16], &NIST_FIRST_BLOCK);
        let plain = material().decrypt(&enc, DEFAULT_MAX_PLAIN_BYTES).unwrap();
        assert_eq!(&plain[..], &NIST_PLAINTEXT[..]);
    }

    #[test]
    fn roundtrip_random_sizes() {
        for size in [0usize, 1, 15, 16, 17, 1000, 65_537] {
            let plain: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let cipher = material().encrypt(&plain).unwrap();
            assert_eq!(cipher.len() % 16, 0);
            let out = material()
                .decrypt(&cipher, DEFAULT_MAX_PLAIN_BYTES)
                .unwrap();
            assert_eq!(&out[..], &plain[..]);
        }
    }

    #[test]
    fn rejects_malformed_inputs() {
        let m = material();
        assert_eq!(m.decrypt(&[], 1000), Err(CryptoError::Empty));
        assert_eq!(
            m.decrypt(&[0u8; 17], 1000),
            Err(CryptoError::NotBlockAligned)
        );
        // A zero block almost certainly has invalid padding.
        assert_eq!(m.decrypt(&[0u8; 16], 1000), Err(CryptoError::BadPadding));
        let big = vec![0u8; 16 * 10];
        assert_eq!(m.decrypt(&big, 16), Err(CryptoError::TooLarge));
    }

    #[test]
    fn rejects_wrong_material_length() {
        assert_eq!(
            CryptoMaterial::from_slices(&[0u8; 31], &[0u8; 16]).unwrap_err(),
            CryptoError::BadMaterialLength
        );
    }

    #[test]
    fn debug_never_leaks_material() {
        let text = format!("{:?}", material());
        assert!(text.contains("<redacted>"));
        assert!(!text.contains("603deb10"));
    }

    fn sample_png() -> Vec<u8> {
        let image = image::RgbImage::from_pixel(3, 2, image::Rgb([10, 20, 30]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }

    fn sample_jpeg() -> Vec<u8> {
        let image = image::RgbImage::from_pixel(8, 6, image::Rgb([200, 100, 50]));
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        jpeg
    }

    #[test]
    fn detects_png_and_rejects_unknown() {
        let png = sample_png();
        assert_eq!(detect_image(&png), Some(ImageFormat::Png));
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (3, 2));
        assert_eq!(detect_image(b"not an image at all"), None);
        assert_eq!(detect_image(&png[..20]), None);
    }

    #[test]
    fn detects_jpeg_and_fully_decodes() {
        let jpeg = sample_jpeg();
        assert_eq!(detect_image(&jpeg), Some(ImageFormat::Jpeg));
        let decoded = image::load_from_memory(&jpeg).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (8, 6));
    }

    #[test]
    fn valid_padding_with_invalid_header_is_not_an_image() {
        // Looks like a JPEG (SOI, APP0, EOI) but has no coherent marker chain
        // or SOF, so header parsing must reject it.
        let mut fake = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        fake.extend_from_slice(&[0u8; 64]);
        fake.extend_from_slice(&[0xFF, 0xD9]);
        let cipher = material().encrypt(&fake).unwrap();
        let decoded = material()
            .decrypt(&cipher, DEFAULT_MAX_PLAIN_BYTES)
            .unwrap();
        assert_eq!(&decoded[..], &fake[..]);
        assert_eq!(detect_image(&decoded), None);
    }
}
