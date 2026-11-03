import { Buffer } from "node:buffer";

export const MATERIAL_BYTES = 48;

/**
 * Validate the build-only material without ever returning or printing it.
 * Format: base64 of exactly 48 bytes (32-byte AES key followed by 16-byte IV).
 */
export function inspectCryptoMaterial(value) {
  if (value === undefined || value === null || value === "") {
    return { present: false, valid: false, reason: "未设置" };
  }

  const compact = String(value).trim();
  if (compact.length === 0) {
    return { present: false, valid: false, reason: "为空" };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return { present: true, valid: false, reason: "不是合法 base64" };
  }

  let bytes;
  try {
    bytes = Buffer.from(compact, "base64");
  } catch {
    return { present: true, valid: false, reason: "base64 解码失败" };
  }

  const length = bytes.length;
  const allZero = length === MATERIAL_BYTES && bytes.every((byte) => byte === 0);
  bytes.fill(0);

  if (length !== MATERIAL_BYTES) {
    return {
      present: true,
      valid: false,
      reason: `解码后为 ${length} 字节，要求 ${MATERIAL_BYTES} 字节`,
    };
  }
  if (allZero) {
    return { present: true, valid: false, reason: "48 字节均为 0，疑似占位材料" };
  }
  return { present: true, valid: true, reason: `48 字节` };
}

export function assertReleaseMaterial(env = process.env) {
  const status = inspectCryptoMaterial(env.HEARTOPIA_CRYPTO_MATERIAL_B64);
  if (!status.valid) {
    throw new Error(
      `发布构建缺少有效的 HEARTOPIA_CRYPTO_MATERIAL_B64（${status.reason}）。` +
        "请通过 GitHub Actions secret 注入；不要把材料写入仓库或日志。",
    );
  }
  return status;
}
