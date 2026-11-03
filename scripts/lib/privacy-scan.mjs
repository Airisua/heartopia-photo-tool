import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_TEXT_BYTES = 8 * 1024 * 1024;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const PUBLIC_NOREPLY_EMAIL = "Airisua@users.noreply.github.com";
const ALLOWED_ICON_PREFIX = "src-tauri/icons/";
const GENERATED_ICON_EXTENSIONS = new Set([".icns", ".ico", ".png"]);

export const ALLOWED_GENERATED_ICON_PREFIX = ALLOWED_ICON_PREFIX;

export const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".apk",
  ".appx",
  ".bin",
  ".bmp",
  ".bz2",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".exe",
  ".gif",
  ".gz",
  ".heic",
  ".ico",
  ".icns",
  ".iso",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lib",
  ".m4a",
  ".mov",
  ".mp3",
  ".mp4",
  ".msi",
  ".msix",
  ".nupkg",
  ".otf",
  ".pdb",
  ".pdf",
  ".png",
  ".psd",
  ".rar",
  ".so",
  ".tar",
  ".tif",
  ".tiff",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
]);

const PLACEHOLDER_PATTERN =
  /(?:\b(?:change[_ -]?me|dummy|example|fake|placeholder|redacted|sample|sentinel|synthetic|test(?:[-_ ]?(?:value|token|key|secret|password))?)\b|<[^>\r\n]+>|\{\{[^}\r\n]+\}\}|\$\{[^}\r\n]+\}|\$env:[A-Za-z_][\w]*|%[A-Za-z_][\w]*%|(?:\b(?:YOUR|MY|TODO|PRIVATE|TEST)[A-Z0-9_]*\b)|not[-_ ]?a[-_ ]?real)/i;

const LEGACY_BYPASS_PATTERN =
  /\bsecret-scan:\s*(?:allow-file|allow(?:[-_ ](?:file|line|block))?|synthetic-test-vector)\b/i;
const SYNTHETIC_MARKER_PATTERN =
  /\b(?:privacy|secret)-scan:\s*synthetic-vector\b/i;

const GITHUB_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const BEARER_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}\b/i;
const AWS_ACCESS_KEY_PATTERN =
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/;
const AWS_SECRET_ACCESS_KEY_PATTERN =
  /\bAWS_SECRET_ACCESS_KEY\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/i;
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const MINISIGN_PRIVATE_COMMENT_PATTERN =
  /^untrusted comment:.*(?:secret key|private key)/i;
const PRIVATE_USER_PATH_WINDOWS_PATTERN =
  /\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>]+)/gi;
const PRIVATE_USER_PATH_UNC_PATTERN =
  /\\\\[^\\/\s]+[\\/]+Users[\\/]+([^\\/\s"'`<>]+)/gi;
const PRIVATE_USER_PATH_UNIX_PATTERN =
  /(?<![\w])\/(?:home|Users)\/([A-Za-z0-9._-]+)/g;
const EMAIL_PATTERN =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const LOCAL_SCALE_PATTERN =
  /\b(?:19[,_\uFF0C ]?775|19[,_\uFF0C ]?780|19[,_\uFF0C ]?783|19[,_\uFF0C ]?504|4[,_\uFF0C ]?635)\b|\b(?:3\.2\s*(?:GB|GiB)|4\.75\s*(?:GiB|GB))\b/i;
const HOST_FIELD_PATTERN =
  /(?:^|[|,;]\s*)((?:ComputerName|Computer Name|HostName|Host Name|MachineName|Machine Name|Machine Model|SystemModel|System Model|System Manufacturer|System Product Name|DeviceModel|Device Model|Hardware|Hardware Model|Manufacturer|Model|BaseBoard|SerialNumber|Serial Number|Serial|SN|BIOS|BIOS Version|Processor|Processor Name|CPU|GPU|UserName|User Name|Username|机器型号|设备型号|主机名|用户名|处理器|显卡|序列号))\s*[:：=]\s*(.+)$/i;

const SPECIAL_SECRET_PATTERN =
  /\b(?:TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?|TAURI_KEY_PASSWORD)\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/i;
const CRYPTO_MATERIAL_PATTERN =
  /\b(?:HEARTOPIA_CRYPTO_MATERIAL(?:_B64)?|CRYPTO_MATERIAL(?:_B64)?|AES_(?:KEY|IV)|ENCRYPT(?:ION)?_KEY|SIGNING_(?:KEY|SECRET))\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/i;
const GENERIC_SECRET_PATTERN =
  /\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|accessToken|refreshToken)\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/i;
const ARRAY_ASSIGNMENT_PATTERN =
  /(?:\b(?:const|let|static|mut)\s+)?\b(KEY(?:_BYTES)?|IV(?:_BYTES)?|AES_KEY|SECRET(?:_KEY)?|PASSWORD|TOKEN|SEED|NONCE|CRYPTO(?:_MATERIAL)?)\s*(?::\s*\[u8;\s*(?:16|32)\s*\])?\s*=\s*\[/i;

const PLACEHOLDER_USERNAMES = new Set([
  "all",
  "all users",
  "anonymous",
  "default",
  "default user",
  "example",
  "exampleuser",
  "guest",
  "name",
  "private",
  "private_test_user",
  "redacted",
  "public",
  "shared",
  "test",
  "testuser",
  "unknown",
  "user",
  "username",
  "youruser",
]);

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

function splitNul(value) {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    input: options.input,
    encoding: options.encoding === null ? null : (options.encoding ?? "utf8"),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
  });
}

function safeGit(root, args, options = {}) {
  try {
    return git(root, args, options);
  } catch {
    return null;
  }
}

function walkFiles(root, directory = root, output = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") {
      continue;
    }
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkFiles(root, absolute, output);
    } else if (entry.isFile()) {
      output.push(toPosix(relativePath(root, absolute)));
    }
  }
  return output;
}

export function collectWorkingTreeFiles(root) {
  const listed = safeGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (listed === null) return walkFiles(root);
  return [...new Set(splitNul(listed))];
}

export function collectStagedFiles(root) {
  const listed = safeGit(root, [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
  ]);
  if (listed === null) return [];
  return [...new Set(splitNul(listed))];
}

export function readStagedFile(root, file) {
  const content = safeGit(root, ["show", `:${file}`], { encoding: null });
  return content === null ? null : Buffer.from(content);
}

export function isGeneratedIconPath(file) {
  return toPosix(file)
    .replace(/^\.?\//, "")
    .toLowerCase()
    .startsWith(ALLOWED_ICON_PREFIX);
}

function isGeneratedIconFile(file) {
  return (
    isGeneratedIconPath(file) &&
    GENERATED_ICON_EXTENSIONS.has(extname(toPosix(file)).toLowerCase())
  );
}

export function looksBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const sample = buffer.subarray(0, 8192);
  const magic = [
    [0x89, 0x50, 0x4e, 0x47],
    [0xff, 0xd8, 0xff],
    [0x47, 0x49, 0x46, 0x38],
    [0x25, 0x50, 0x44, 0x46, 0x2d],
    [0x50, 0x4b, 0x03, 0x04],
    [0x1f, 0x8b],
    [0x7f, 0x45, 0x4c, 0x46],
    [0x4d, 0x5a],
    [0x00, 0x00, 0x01, 0x00],
    [0x37, 0x7a, 0xbc, 0xaf],
    [0x52, 0x61, 0x72, 0x21],
  ];
  if (
    magic.some(
      (signature) =>
        sample.length >= signature.length &&
        signature.every((byte, index) => sample[index] === byte),
    )
  ) {
    return true;
  }
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.length > 0.3;
}

function isBinaryPath(file) {
  return BINARY_EXTENSIONS.has(extname(toPosix(file)).toLowerCase());
}

function normalizeUserName(value) {
  return value.replace(/^[\\/]+|[\\/]+$/g, "").trim().toLowerCase();
}

function isPlaceholderUsername(value) {
  const lower = normalizeUserName(value);
  if (!lower) return true;
  if (PLACEHOLDER_USERNAMES.has(lower)) return true;
  return (
    lower.startsWith("<") ||
    lower.startsWith("$") ||
    lower.startsWith("%") ||
    lower.startsWith("{") ||
    lower.includes("<") ||
    lower.includes(">") ||
    lower.includes("${") ||
    lower.includes("%username%") ||
    lower.includes("*") ||
    lower.includes("?") ||
    lower.includes("your_") ||
    lower.includes("your-") ||
    lower.startsWith("your")
  );
}

function isPlaceholderEmail(value) {
  const lower = value.toLowerCase();
  if (lower === PUBLIC_NOREPLY_EMAIL.toLowerCase()) return true;
  if (lower === "git@github.com" || lower === "git@gitlab.com") return true;
  const [local, domain] = lower.split("@");
  if (!local || !domain) return false;
  if (BINARY_EXTENSIONS.has(`.${domain.split(".").pop()}`)) return true;
  if (
    domain === "example.com" ||
    domain === "example.org" ||
    domain === "example.net" ||
    domain === "example.test" ||
    domain === "test" ||
    domain === "invalid" ||
    domain === "localhost" ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".example")
  ) {
    return true;
  }
  return /^(?:example|test|user|you|name|email|someone|noreply|no-reply|donotreply|maintainer)(?:$|[+._-])/.test(
    local,
  );
}

function unquote(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "");
}

function isPlaceholderValue(value) {
  const text = unquote(value);
  if (!text) return true;
  if (/^(?:[|>]|[-+][|>])$/.test(text)) return true;
  if (/^[\s)\]}>,"'`;]+$/.test(text)) return true;
  if (PLACEHOLDER_PATTERN.test(text)) return true;
  if (/^(?:true|false|null|none|undefined)$/i.test(text)) return true;
  if (/^[$\[]/.test(text)) return true;
  if (text.includes("ReadAllText") || text.includes("process.env")) return true;
  return false;
}

function looksLikeKeyMaterial(value) {
  const text = unquote(value);
  if (isPlaceholderValue(text)) return false;
  if (text.includes("-----BEGIN ")) return true;
  if (/^[A-Za-z0-9+/=_-]{24,}$/.test(text)) return true;
  if (/^[0-9a-f]{32,}$/i.test(text)) return true;
  if (text.startsWith("untrusted comment:")) return true;
  return false;
}

function looksLikePassword(value) {
  const text = unquote(value);
  return text.length >= 8 && !isPlaceholderValue(text) && !/^\d+$/.test(text);
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function hasSyntheticMarker(lines, index) {
  const start = Math.max(0, index - 12);
  for (let cursor = start; cursor <= index; cursor += 1) {
    const line = lines[cursor];
    if (SYNTHETIC_MARKER_PATTERN.test(line)) return true;
    if (
      /comment/i.test(line) === false &&
      /synthetic|nist/i.test(line) &&
      /(?:material|vector|only|never replace)/i.test(line)
    ) {
      return true;
    }
  }
  return false;
}

function addFinding(findings, scope, path, line, category) {
  const key = `${scope}\u0000${path}\u0000${line}\u0000${category}`;
  if (!findings.has(key)) {
    findings.set(key, { scope, path, line, category });
  }
}

function checkAssignment(line, pattern, category, findings, add, index) {
  const match = pattern.exec(line);
  if (!match) return;
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  if (isPlaceholderValue(value)) return;
  add(category, index);
}

function checkRawKeyArray(lines, line, index, findings, add) {
  const match = ARRAY_ASSIGNMENT_PATTERN.exec(line);
  if (!match) return;
  if (hasSyntheticMarker(lines, index)) return;

  const name = match[1].toUpperCase();
  const isSensitiveName =
    /^(?:KEY(?:_BYTES)?|IV(?:_BYTES)?|AES_KEY|SECRET(?:_KEY)?|PASSWORD|TOKEN|SEED|NONCE|CRYPTO(?:_MATERIAL)?)$/.test(
      name,
    );
  if (!isSensitiveName) return;

  const windowText = lines.slice(index, index + 20).join("\n");
  const numbers = windowText.match(/\b(?:0x[0-9a-f]{1,2}|\d{1,3})\b/gi) ?? [];
  if (numbers.length >= 16) add("raw-key-material", index);
}

function checkHostField(line, add, index) {
  const match = HOST_FIELD_PATTERN.exec(line);
  if (!match) return;
  const value = unquote(match[2]);
  if (!value || /^(?:<|%|\{|\$)|(?:不记录|未提供|脱敏|隐藏|redacted|hidden|placeholder|未知|n\/a)/i.test(value)) {
    return;
  }
  add("host-detail", index);
}

function checkTextLine(line, options) {
  const {
    index,
    lines,
    findings,
    scope,
    path,
    add,
    knownSecrets,
  } = options;

  if (LEGACY_BYPASS_PATTERN.test(line)) {
    add("unsafe-scan-bypass", index);
  }

  if (GITHUB_TOKEN_PATTERN.test(line)) add("github-token", index);
  if (JWT_PATTERN.test(line)) add("jwt-token", index);
  if (BEARER_PATTERN.test(line)) add("bearer-token", index);
  if (AWS_ACCESS_KEY_PATTERN.test(line)) add("aws-access-key", index);
  checkAssignment(
    line,
    AWS_SECRET_ACCESS_KEY_PATTERN,
    "aws-secret-key",
    findings,
    add,
    index,
  );
  if (PEM_PRIVATE_KEY_PATTERN.test(line)) add("private-key-block", index);
  if (MINISIGN_PRIVATE_COMMENT_PATTERN.test(line)) add("private-key-block", index);

  checkAssignment(line, SPECIAL_SECRET_PATTERN, "signing-key-value", findings, add, index);
  checkAssignment(line, CRYPTO_MATERIAL_PATTERN, "crypto-material-value", findings, add, index);
  checkAssignment(line, GENERIC_SECRET_PATTERN, "secret-assignment", findings, add, index);

  const tauriPassword = /\bTAURI_SIGNING_PRIVATE_KEY_PASSWORD\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/i.exec(
    line,
  );
  if (tauriPassword) {
    const value = tauriPassword[1] ?? tauriPassword[2] ?? tauriPassword[3] ?? "";
    if (looksLikePassword(value)) add("signing-key-password", index);
  }

  const cryptoMaterial = /\b(?:HEARTOPIA_CRYPTO_MATERIAL_B64|CRYPTO_MATERIAL_B64)\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/i.exec(
    line,
  );
  if (cryptoMaterial) {
    const value = cryptoMaterial[1] ?? cryptoMaterial[2] ?? cryptoMaterial[3] ?? "";
    if (looksLikeKeyMaterial(value)) add("crypto-material-value", index);
  }

  const keyAssignment = /\b(?:TAURI_SIGNING_PRIVATE_KEY|TAURI_KEY_PASSWORD)\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/i.exec(
    line,
  );
  if (keyAssignment) {
    const value = keyAssignment[1] ?? keyAssignment[2] ?? keyAssignment[3] ?? "";
    if (looksLikeKeyMaterial(value) || looksLikePassword(value)) {
      add("signing-key-value", index);
    }
  }

  checkRawKeyArray(lines, line, index, findings, add);

  for (const pattern of [
    PRIVATE_USER_PATH_WINDOWS_PATTERN,
    PRIVATE_USER_PATH_UNC_PATTERN,
    PRIVATE_USER_PATH_UNIX_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const start = match.index;
      const before = line.slice(0, start);
      const token = before.split(/[\s"'`]+/).pop() ?? "";
      if (/^(?:https?|ftp):\/\//i.test(token)) {
        continue;
      }
      if (!isPlaceholderUsername(match[1] ?? "")) {
        add("private-user-path", index);
      }
    }
  }

  EMAIL_PATTERN.lastIndex = 0;
  let email;
  while ((email = EMAIL_PATTERN.exec(line)) !== null) {
    if (!isPlaceholderEmail(email[0])) add("personal-email", index);
  }

  if (LOCAL_SCALE_PATTERN.test(line)) add("local-scale", index);
  checkHostField(line, add, index);

  for (const secret of knownSecrets) {
    if (secret.length >= 8 && line.includes(secret)) {
      add("known-secret", index);
      break;
    }
  }
}

export function scanText(text, options = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  const findings = new Map();
  const scope = options.scope ?? "working";
  const path = options.path ?? "<text>";
  const knownSecrets = normalizeKnownSecrets(options.knownSecrets ?? []);
  const add = (category, lineIndex) => addFinding(findings, scope, path, lineIndex + 1, category);

  for (let index = 0; index < lines.length; index += 1) {
    checkTextLine(lines[index], {
      index,
      lines,
      findings,
      scope,
      path,
      add,
      knownSecrets,
    });
  }

  return [...findings.values()];
}

export function scanFileBuffer(file, buffer, options = {}) {
  const path = toPosix(file).replace(/^\.?\//, "");
  const scope = options.scope ?? "working";
  const findings = new Map();

  if (typeof buffer === "string") buffer = Buffer.from(buffer, "utf8");
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  const generatedIcon = isGeneratedIconFile(path);

  if (isBinaryPath(path) || looksBinary(buffer)) {
    if (generatedIcon) return [];
    addFinding(findings, scope, path, 1, "binary-attachment");
    return [...findings.values()];
  }

  const maxBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  if (buffer.length > maxBytes) {
    addFinding(findings, scope, path, 1, "oversized-text");
    return [...findings.values()];
  }

  const text = buffer.toString("utf8");
  if (text.includes("\uFFFD")) {
    // A text file with invalid UTF-8 can hide bytes from string checks. Treat it
    // as binary rather than silently accepting an unscannable attachment.
    addFinding(findings, scope, path, 1, "binary-attachment");
    return [...findings.values()];
  }

  for (const finding of scanText(text, {
    scope,
    path,
    knownSecrets: options.knownSecrets ?? [],
  })) {
    addFinding(findings, finding.scope, finding.path, finding.line, finding.category);
  }
  return [...findings.values()];
}

function scanWorkingFile(root, file, options = {}) {
  const path = toPosix(file).replace(/^\.?\//, "");
  const scope = options.scope ?? "working";
  const findings = new Map();
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) return [];

  let info;
  try {
    info = statSync(absolute);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size === 0) return [];

  if (isBinaryPath(path)) {
    if (!isGeneratedIconFile(path)) {
      addFinding(findings, scope, path, 1, "binary-attachment");
    }
    return [...findings.values()];
  }

  const maxBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  if (info.size > maxBytes) {
    addFinding(findings, scope, path, 1, "oversized-file");
    return [...findings.values()];
  }

  let buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return [];
  }
  return scanFileBuffer(path, buffer, { scope, knownSecrets: options.knownSecrets });
}

export function loadKnownSecrets(file) {
  const text = readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  }
  return normalizeKnownSecrets(parsed);
}

export function normalizeKnownSecrets(input) {
  const values = [];
  const visit = (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length >= 8) values.push(trimmed);
      return;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      const text = String(value);
      if (text.length >= 8) values.push(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(input);

  const expanded = new Set();
  for (const value of values) {
    expanded.add(value);
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
      try {
        const decoded = Buffer.from(value, "base64").toString("utf8");
        if (decoded.length >= 8 && !decoded.includes("\uFFFD")) expanded.add(decoded);
      } catch {
        // Ignore malformed optional base64 representations.
      }
    }
    if (/^[0-9a-f]{16,}$/i.test(value) && value.length % 2 === 0) {
      const decoded = Buffer.from(value, "hex").toString("utf8");
      if (decoded.length >= 8 && !decoded.includes("\uFFFD")) expanded.add(decoded);
    }
  }
  return [...expanded].sort((a, b) => b.length - a.length);
}

function scanHistory(root, options = {}) {
  const findings = new Map();
  const knownSecrets = normalizeKnownSecrets(options.knownSecrets ?? []);
  const listed = git(root, ["rev-list", "--objects", "--all"], { encoding: "utf8" });
  const entries = new Map();

  for (const line of listed.split(/\r?\n/)) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const oid = line.slice(0, space);
    const path = line.slice(space + 1);
    if (!path) continue;
    if (!entries.has(oid)) entries.set(oid, new Set());
    entries.get(oid).add(path);
  }

  const oids = [...entries.keys()];
  if (oids.length > 0) {
    const checked = git(root, ["cat-file", "--batch-check"], {
      input: `${oids.join("\n")}\n`,
      encoding: "utf8",
    });
    for (const line of checked.split(/\r?\n/)) {
      const match = /^([0-9a-f]{40,64})\s+(\w+)\s+(\d+)$/.exec(line.trim());
      if (!match || match[2] !== "blob") continue;
      const oid = match[1];
      const paths = entries.get(oid);
      if (!paths) continue;
      const size = Number(match[3]);
      for (const path of paths) {
        if (isBinaryPath(path)) {
          if (!isGeneratedIconFile(path)) {
            addFinding(findings, "history", path, 1, "binary-attachment");
          }
          continue;
        }
        if (Number.isFinite(size) && size > DEFAULT_MAX_TEXT_BYTES) {
          addFinding(findings, "history", path, 1, "oversized-file");
          continue;
        }
        const content = safeGit(root, ["cat-file", "blob", oid], { encoding: null });
        if (content === null) continue;
        const buffer = Buffer.from(content);
        for (const finding of scanFileBuffer(path, buffer, {
          scope: "history",
          knownSecrets,
        })) {
          addFinding(
            findings,
            finding.scope,
            finding.path,
            finding.line,
            finding.category,
          );
        }
      }
    }
  }

  const authorEmails = safeGit(root, ["log", "--all", "--format=%ae"], {
    encoding: "utf8",
  });
  if (authorEmails !== null) {
    for (const email of new Set(authorEmails.split(/\r?\n/).filter(Boolean))) {
      for (const finding of scanText(email, {
        scope: "history",
        path: "history:commit-metadata",
        knownSecrets,
      })) {
        if (finding.category === "personal-email") {
          addFinding(findings, finding.scope, finding.path, finding.line, finding.category);
        }
      }
    }
  }

  const messages = safeGit(root, ["log", "--all", "--format=%B"], { encoding: "utf8" });
  if (messages !== null) {
    for (const finding of scanText(messages, {
      scope: "history",
      path: "history:commit-message",
      knownSecrets,
    })) {
      addFinding(findings, finding.scope, finding.path, finding.line, finding.category);
    }
  }

  return [...findings.values()];
}

function sortFindings(findings) {
  return findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.category.localeCompare(b.category),
  );
}

export function scanRepository(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const scope = options.scope ?? "working";
  const knownSecrets = normalizeKnownSecrets(options.knownSecrets ?? []);
  const findings = new Map();

  if (scope === "history") {
    for (const finding of scanHistory(root, { knownSecrets })) {
      addFinding(
        findings,
        finding.scope,
        finding.path,
        finding.line,
        finding.category,
      );
    }
    return { scope, findings: sortFindings([...findings.values()]) };
  }

  const files = scope === "staged" ? collectStagedFiles(root) : collectWorkingTreeFiles(root);
  for (const file of files) {
    let fileFindings;
    if (scope === "staged") {
      const buffer = readStagedFile(root, file);
      if (!buffer) continue;
      fileFindings = scanFileBuffer(file, buffer, {
        scope,
        knownSecrets,
      });
    } else {
      fileFindings = scanWorkingFile(root, file, { scope, knownSecrets });
    }
    for (const finding of fileFindings) {
      addFinding(
        findings,
        finding.scope,
        finding.path,
        finding.line,
        finding.category,
      );
    }
  }

  return { scope, findings: sortFindings([...findings.values()]) };
}

export function repoRootFromModule() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
