import { Buffer } from "node:buffer";

/**
 * Tauri `.sig` files are base64-encoded minisign signatures. The trusted
 * comment is covered by minisign's global signature and newer Tauri CLI
 * releases include a `version:<app-version>` field there.
 */
export function inspectTauriSignature(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { valid: false, reason: "空签名" };
  }

  const encoded = value.replace(/\s+/g, "");
  let envelope;
  try {
    envelope = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return { valid: false, reason: "base64 解码失败" };
  }

  const lines = envelope.split(/\r?\n/);
  const trustedLine = lines.find((line) => line.startsWith("trusted comment:"));
  if (!trustedLine) {
    return { valid: false, reason: "缺少 trusted comment" };
  }

  const comment = trustedLine.slice("trusted comment:".length).trim();
  const fields = new Map();
  for (const field of comment.split("\t")) {
    const separator = field.indexOf(":");
    if (separator > 0) {
      fields.set(field.slice(0, separator), field.slice(separator + 1));
    }
  }

  return {
    valid: true,
    comment,
    version: fields.get("version") ?? null,
    file: fields.get("file") ?? null,
    timestamp: fields.get("timestamp") ?? null,
  };
}

export function signatureVersionMatches(signature, version) {
  const info = inspectTauriSignature(signature);
  if (!info.valid) return { ok: false, reason: info.reason, info };
  if (!info.version) {
    return { ok: false, reason: "trusted comment 缺少 version", info };
  }
  const signed = String(info.version).replace(/^v/, "");
  const expected = String(version).replace(/^v/, "");
  if (signed !== expected) {
    return { ok: false, reason: `签名版本 ${signed} != ${expected}`, info };
  }
  return { ok: true, reason: "版本绑定一致", info };
}
