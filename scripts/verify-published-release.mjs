#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { signatureVersionMatches } from "./lib/signature.mjs";

export const DEFAULT_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 8000;

export function isRetryableStatus(status) {
  return (
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function backoffMs(attempt, baseDelayMs, maxDelayMs, retryAfterMs) {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const candidate = retryAfterMs == null ? exponential : Math.max(exponential, retryAfterMs);
  return Math.min(Math.max(0, candidate), maxDelayMs);
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being retried or rejected; a body cancellation failure
    // must not mask the HTTP status that caused it.
  }
}

/**
 * Fetches with a bounded retry budget. 403/404/408/429 and 5xx are retried
 * because release assets can be briefly unavailable right after publishing;
 * the final attempt is returned as-is so a genuine 404 still fails the caller.
 */
export async function fetchWithRetry(url, init = {}, options = {}) {
  const {
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    sleep = delay,
    headers = {},
  } = options;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await sleep(backoffMs(attempt, baseDelayMs, maxDelayMs, null));
      continue;
    }

    if (!isRetryableStatus(response.status)) return response;

    lastError = new Error(`HTTP ${response.status}`);
    if (attempt >= attempts) return response;

    await discardBody(response);
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    await sleep(backoffMs(attempt, baseDelayMs, maxDelayMs, retryAfter));
  }

  throw lastError ?? new Error("request failed");
}

/**
 * Consumes a response body as a stream and returns its size and SHA-256.
 * The body is never buffered in full, so a ~200 MiB installer stays bounded.
 */
export async function hashResponseBody(response) {
  if (!response.body) throw new Error("response body missing");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export async function downloadAndHash(url, options = {}) {
  const response = await fetchWithRetry(
    url,
    { redirect: "follow" },
    {
      headers: options.headers,
      attempts: options.attempts,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      sleep: options.sleep,
      fetchImpl: options.fetchImpl,
    },
  );
  if (!response.ok) {
    await discardBody(response);
    return { ok: false, status: response.status, sha256: null, bytes: 0 };
  }
  return { ok: true, status: response.status, ...(await hashResponseBody(response)) };
}

export function validateSummary(summary, { version, assetName }) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return ["release-summary.json 不是 JSON 对象"];
  }
  const failures = [];
  if (String(summary.version ?? "").replace(/^v/, "") !== version) {
    failures.push("release-summary.json version 与 tag 不一致");
  }
  if (String(summary.setup ?? "") !== assetName) {
    failures.push("release-summary.json setup 与资产文件名不一致");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(summary.sha256 ?? ""))) {
    failures.push("release-summary.json sha256 缺失或格式不合法");
  }
  if (!Number.isSafeInteger(summary.sizeBytes) || summary.sizeBytes <= 0) {
    failures.push("release-summary.json sizeBytes 缺失或非法");
  }
  return failures;
}

export function compareSummaryHash(summary, result) {
  const failures = [];
  if (String(result.sha256).toLowerCase() !== String(summary.sha256).toLowerCase()) {
    failures.push("下载资产 sha256 与 release-summary.json 不一致");
  }
  if (result.bytes !== summary.sizeBytes) {
    failures.push("下载资产大小与 release-summary.json 不一致");
  }
  return failures;
}

function assetNameFromUrl(url) {
  try {
    return decodeURIComponent(url.pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const option = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };

  const repo = option("--repo", "Airisua/heartopia-photo-tool");
  const tag = option("--tag", null);
  if (!tag) {
    console.error(
      "用法: node scripts/verify-published-release.mjs --tag v0.1.0 [--repo owner/repo] [--summary PATH]",
    );
    return 2;
  }

  const version = tag.replace(/^v/, "");
  const manifestUrl =
    option("--manifest-url") ??
    `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/latest.json`;
  const summaryPath = option("--summary");
  const token = env.GITHUB_TOKEN?.trim();
  const headers = {
    accept: "application/json, application/octet-stream;q=0.9,*/*;q=0.8",
    "user-agent": "heartopia-photo-tool-release-verifier",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const failures = [];

  let manifestResponse;
  try {
    manifestResponse = await fetchWithRetry(
      manifestUrl,
      { redirect: "follow" },
      { headers },
    );
  } catch (error) {
    console.error(`published release: FAIL (无法获取 latest.json: ${error.message})`);
    return 1;
  }
  if (!manifestResponse.ok) {
    console.error(`published release: FAIL (latest.json HTTP ${manifestResponse.status})`);
    return 1;
  }

  let manifest;
  try {
    manifest = await manifestResponse.json();
  } catch {
    console.error("published release: FAIL (latest.json 不是合法 JSON)");
    return 1;
  }

  if (String(manifest.version).replace(/^v/, "") !== version) {
    failures.push(`manifest.version=${manifest.version}，期望 ${version}`);
  }
  if (manifest.pub_date && Number.isNaN(Date.parse(manifest.pub_date))) {
    failures.push("manifest.pub_date 不是 RFC3339 时间");
  }

  const platform = manifest.platforms?.["windows-x86_64"];
  let assetUrl = null;
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
    try {
      assetUrl = new URL(platform.url);
    } catch {
      failures.push("windows-x86_64.url 不是合法 URL");
    }
    if (assetUrl) {
      if (assetUrl.protocol !== "https:") failures.push("更新下载 URL 必须使用 HTTPS");
      if (assetUrl.hostname !== "github.com") failures.push("更新下载 URL 应指向 github.com Release");
      try {
        const probe = await fetchWithRetry(
          assetUrl.href,
          {
            method: "GET",
            redirect: "follow",
            headers: { range: "bytes=0-0" },
          },
          { headers },
        );
        if (![200, 206].includes(probe.status)) {
          failures.push(`安装包 URL HTTP ${probe.status}`);
        } else {
          const range = probe.headers.get("content-range");
          const total = Number(range?.split("/")?.[1] ?? probe.headers.get("content-length") ?? 0);
          if (total > 0 && total < 100 * 1024 * 1024) {
            failures.push(`安装包仅 ${(total / 1024 / 1024).toFixed(1)} MiB，疑似未内置 WebView2`);
          }
        }
        await probe.body?.cancel();
      } catch (error) {
        failures.push(`安装包 URL 不可访问 (${error.message})`);
      }
    }
  }

  let hashNote = null;
  if (summaryPath) {
    let summary = null;
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch {
      failures.push("release-summary.json 无法读取或不是合法 JSON");
    }
    if (summary) {
      if (!assetUrl) {
        failures.push("无法用 release-summary.json 绑定资产：manifest URL 不可用");
      } else {
        const assetName = assetNameFromUrl(assetUrl);
        const metadataFailures = validateSummary(summary, { version, assetName });
        failures.push(...metadataFailures);
        if (metadataFailures.length === 0) {
          const result = await downloadAndHash(assetUrl.href, { headers });
          if (!result.ok) {
            failures.push(`安装包下载 HTTP ${result.status}`);
          } else {
            const hashFailures = compareSummaryHash(summary, result);
            failures.push(...hashFailures);
            if (hashFailures.length === 0) {
              hashNote = `- ${assetName} sha256 ${result.sha256} matches release-summary.json`;
            }
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error("published release: FAIL");
    for (const item of failures) console.error(`- ${item}`);
    return 1;
  }

  console.log("published release: PASS");
  console.log(`- ${repo} ${tag}`);
  console.log("- windows-x86_64 manifest, signed update URL reachable");
  if (hashNote) console.log(hashNote);
  return 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("published release: FAIL (内部错误)");
      process.exitCode = 1;
    });
}
