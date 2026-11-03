#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxBytes = 2 * 1024 * 1024;
const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".icns",
  ".exe",
  ".dll",
  ".msi",
  ".zip",
  ".gz",
  ".7z",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".bin",
  ".pdb",
]);

const patterns = [
  {
    name: "private-key-block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws-secret", re: /\baws_secret_access_key\s*[:=]\s*["'][^"']{20,}/gi },
  {
    name: "tauri-private-key-value",
    re: /\bTAURI_SIGNING_PRIVATE_KEY\s*[:=]\s*["']?[A-Za-z0-9+/=]{40,}/g,
  },
  {
    name: "crypto-material-value",
    re: /\bHEARTOPIA_CRYPTO_MATERIAL_B64\s*[:=]\s*["']?[A-Za-z0-9+/=]{40,}/g,
  },
  {
    name: "absolute-windows-user-path",
    re: /\b[A-Za-z]:\\Users\\(?!<|%|\{|\$|\*|PRIVATE_|TEST_|EXAMPLE_|REDACTED_|SENTINEL|Example|Test|Alice|Bob|User)[^\\\s"'`]+/gi,
  },
  {
    name: "absolute-unix-user-path",
    re: /(?:\/home\/|\/Users\/)(?!<|%|\{|\$|\*|Example|Test|Alice|Bob|User)[A-Za-z0-9._-]+/gi,
  },
];

function listedFiles() {
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return [...new Set(output.split("\0").filter(Boolean))];
}

const findings = [];

for (const relative of listedFiles()) {
  const file = join(root, relative);
  if (!existsSync(file)) continue;
  const info = statSync(file);
  if (!info.isFile() || info.size === 0 || info.size > maxBytes) continue;
  if (binaryExtensions.has(extname(relative).toLowerCase())) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;

  const allowed = false;
  if (allowed) continue;

  const lines = text.split(/\r?\n/);
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(text)) !== null) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      const context = lines.slice(Math.max(0, line - 3), line + 2).join("\n");
      
      findings.push({ relative, line, name: pattern.name });
      break;
    }
  }

  
  const arrayPattern = /(?:new\s+byte\s*\[\s*(?:16|32)\s*\]|\[\s*u8\s*;\s*(?:16|32)\s*\])/gi;
  let match;
  while ((match = arrayPattern.exec(text)) !== null) {
    const windowText = text.slice(match.index, match.index + 1600);
    const numbers = windowText.match(/\b\d{1,3}\b/g) ?? [];
    if (numbers.length >= 24) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      const context = lines.slice(Math.max(0, line - 3), line + 3).join("\n");
      if (true) {
        findings.push({ relative, line, name: "possible-raw-key-or-iv-array" });
      }
      break;
    }
  }
}

if (findings.length > 0) {
  console.error("secret scan: FAIL");
  for (const finding of findings) {
    console.error(`- ${finding.relative}:${finding.line} [${finding.name}]`);
  }
  console.error("仅显示位置，不显示匹配内容。移除秘密，或在确认是合成测试向量时加 secret-scan 标记。");
  process.exit(1);
}

console.log("secret scan: PASS (no tracked secrets or absolute user paths found)");
