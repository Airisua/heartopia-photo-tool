#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { signatureVersionMatches } from "./lib/signature.mjs";

const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const repo = option("--repo", "Airisua/heartopia-photo-tool");
const tag = option("--tag", null);
if (!tag) {
  console.error("用法: node scripts/verify-published-release.mjs --tag v0.1.0 [--repo owner/repo]");
  process.exit(2);
}

const version = tag.replace(/^v/, "");
const manifestUrl =
  option("--manifest-url") ??
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/latest.json`;
const token = process.env.GITHUB_TOKEN?.trim();
const headers = {
  "accept": "application/json, application/octet-stream;q=0.9,*/*;q=0.8",
  "user-agent": "heartopia-photo-tool-release-verifier",
};
if (token) headers.authorization = `Bearer ${token}`;

const failures = [];

async function fetchWithRetry(url, init, attempts = 10) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(attempt * 2000, 10000));
  }
  throw lastError ?? new Error("request failed");
}

let manifestResponse;
try {
  manifestResponse = await fetchWithRetry(manifestUrl, { redirect: "follow" });
} catch (error) {
  console.error(`published release: FAIL (无法获取 latest.json: ${error.message})`);
  process.exit(1);
}
if (!manifestResponse.ok) {
  console.error(`published release: FAIL (latest.json HTTP ${manifestResponse.status})`);
  process.exit(1);
}

let manifest;
try {
  manifest = await manifestResponse.json();
} catch {
  console.error("published release: FAIL (latest.json 不是合法 JSON)");
  process.exit(1);
}

if (String(manifest.version).replace(/^v/, "") !== version) {
  failures.push(`manifest.version=${manifest.version}，期望 ${version}`);
}
if (manifest.pub_date && Number.isNaN(Date.parse(manifest.pub_date))) {
  failures.push("manifest.pub_date 不是 RFC3339 时间");
}

const platform = manifest.platforms?.["windows-x86_64"];
if (!platform) {
  failures.push("manifest 缺少 windows-x86_64");
} else {
  if (typeof platform.signature !== "string" || platform.signature.trim().length < 40) {
    failures.push("windows-x86_64.signature 缺失或过短");
  } else {
    const versionCheck = signatureVersionMatches(platform.signature, version);
    if (!versionCheck.ok) {
      failures.push(`windows-x86_64.signature 未绑定版本：${versionCheck.reason}`);
    }
  }
  let url;
  try {
    url = new URL(platform.url);
  } catch {
    failures.push("windows-x86_64.url 不是合法 URL");
  }
  if (url) {
    if (url.protocol !== "https:") failures.push("更新下载 URL 必须使用 HTTPS");
    if (url.hostname !== "github.com") failures.push("更新下载 URL 应指向 github.com Release");
    try {
      const probe = await fetchWithRetry(url.href, {
        method: "GET",
        redirect: "follow",
        headers: { range: "bytes=0-0" },
      });
      if (![200, 206].includes(probe.status)) {
        failures.push(`安装包 URL HTTP ${probe.status}`);
      } else {
        const range = probe.headers.get("content-range");
        const total = Number(range?.split("/")?.[1] ?? probe.headers.get("content-length") ?? 0);
        if (total > 0 && total < 100 * 1024 * 1024) {
          failures.push(`安装包仅 ${(total / 1024 / 1024).toFixed(1)} MiB，疑似未内置 WebView2`);
        }
        await probe.body?.cancel();
      }
    } catch (error) {
      failures.push(`安装包 URL 不可访问 (${error.message})`);
    }
  }
}

if (failures.length > 0) {
  console.error("published release: FAIL");
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

console.log("published release: PASS");
console.log(`- ${repo} ${tag}`);
console.log(`- windows-x86_64 manifest, signed update URL reachable`);
