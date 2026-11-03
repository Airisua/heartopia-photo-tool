const WINDOWS_PATH = /(?:[A-Za-z]:\\)[^\r\n]*/g;
const UNC_PATH = /\\\\[^\r\n]+/g;
const ENV_PATH = /%USERPROFILE%\\[^\r\n]*/gi;
const WINDOWS_FORWARD_PATH = /(^|[\s("'=])([A-Za-z]:\/[^\r\n]*)/g;
const CREDENTIAL_PAIR =
  /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|authorization)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Redacts anything that looks like a local absolute path before display. */
export function sanitizeUiText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(WINDOWS_PATH, "［本地路径已隐藏］")
    .replace(WINDOWS_FORWARD_PATH, "$1［本地路径已隐藏］")
    .replace(UNC_PATH, "［本地路径已隐藏］")
    .replace(ENV_PATH, "［本地路径已隐藏］")
    .replace(BEARER_TOKEN, "Bearer ［凭据已隐藏］")
    .replace(CREDENTIAL_PAIR, "$1=［凭据已隐藏］")
    .replace(/\0/g, "");
}

function absolutePathLike(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    /^file:\/\/\/?[A-Za-z]:/i.test(value) ||
    /^\/(?:Users|home)\//i.test(value) ||
    /^%USERPROFILE%[\\/]/i.test(value) ||
    /^~[\\/]/.test(value)
  );
}

/**
 * A pasted absolute path must never appear in the search field or persisted
 * preferences. Keep only the final path component, which remains useful for a
 * filename search without exposing parent directories or an account name.
 */
export function sanitizeSearchQuery(value: string): string {
  const cleaned = value.replace(/\0/g, "").slice(0, 512);
  const candidate = cleaned.trim().replace(/^["']|["']$/g, "");
  if (!absolutePathLike(candidate)) return cleaned;
  const withoutScheme = candidate.replace(/^file:\/\/\/?/i, "");
  const segments = withoutScheme
    .split(/[\\/]+/)
    .filter((part) => part && !/^[A-Za-z]:$/.test(part));
  const last = segments.at(-1)?.trim() ?? "";
  return last.replace(/[<>:"|?*\u0000-\u001f]/g, "").slice(0, 180);
}

/** Directory labels are basenames only, even if a backend value is malformed. */
export function safeDirectoryLabel(label: string | null | undefined): string {
  if (!label) return "尚未选择";
  const parts = label.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1)?.trim();
  if (!last || /^[A-Za-z]:$/.test(last) || last === "." || last === "..") {
    return "已选目录";
  }
  return sanitizeUiText(last).slice(0, 80);
}

export function safeFileName(name: string): string {
  const parts = name.split(/[\\/]+/).filter(Boolean);
  return sanitizeUiText(parts.at(-1) ?? "未知文件").slice(0, 180);
}

export function safeRelativePath(relativePath: string): string {
  if (!relativePath || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.startsWith("\\\\")) {
    return "路径已隐藏";
  }
  const normalized = relativePath.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "");
  return sanitizeUiText(normalized).slice(0, 260);
}

export function userMessage(error: unknown, fallback = "操作失败，请稍后重试。"): string {
  if (error instanceof Error && error.message.trim()) {
    return sanitizeUiText(error.message.trim());
  }
  if (typeof error === "string" && error.trim()) {
    return sanitizeUiText(error.trim());
  }
  return fallback;
}
