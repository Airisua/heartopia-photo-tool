#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signatureVersionMatches } from "./lib/signature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = option("--version", pkg.version);
const bundleDir = resolve(root, option("--bundle-dir", "src-tauri/target/release/bundle/nsis"));
const summaryPath = option("--summary");
const allowSmall = args.includes("--allow-small");
const failures = [];

function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

if (!existsSync(bundleDir)) {
  console.error(`release artifacts: FAIL (未找到 ${bundleDir})`);
  process.exit(1);
}

const files = readdirSync(bundleDir);
const setups = files
  .filter((name) => /-setup\.exe$/i.test(name) && !name.endsWith(".sig"))
  .map((name) => join(bundleDir, name));

if (setups.length !== 1) {
  failures.push(`NSIS 目录应恰好有一个 *-setup.exe，实际 ${setups.length} 个`);
}

const setup = setups[0] ?? null;
let signature = null;
let size = 0;
let digest = null;

if (setup) {
  const name = basename(setup);
  if (!name.includes(version)) {
    failures.push(`安装包文件名未包含版本 ${version}`);
  }
  const sigFile = `${setup}.sig`;
  if (!existsSync(sigFile)) {
    failures.push("缺少更新签名文件 *-setup.exe.sig");
  } else {
    signature = readFileSync(sigFile, "utf8").trim();
    if (signature.length < 40 || !/^[A-Za-z0-9+/=\r\n]+$/.test(signature)) {
      failures.push("签名文件为空或格式不合法");
    } else {
      const versionCheck = signatureVersionMatches(signature, version);
      if (!versionCheck.ok) {
        failures.push(`更新签名未绑定版本：${versionCheck.reason}`);
      }
    }
  }

  size = statSync(setup).size;
  digest = await sha256(setup);

  const minimum = 120 * 1024 * 1024;
  if (size < minimum && !allowSmall) {
    failures.push(
      `安装包仅 ${(size / 1024 / 1024).toFixed(1)} MiB；离线 WebView2 安装器应使体积超过 120 MiB`,
    );
  }
}

const manifestPath = option("--manifest");
if (manifestPath && setup) {
  if (!existsSync(manifestPath)) {
    failures.push("指定的 latest.json 不存在");
  } else {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      failures.push("latest.json 不是合法 JSON");
    }
    if (manifest) {
      if (String(manifest.version).replace(/^v/, "") !== version) {
        failures.push("latest.json version 与构建版本不一致");
      }
      const platform = manifest.platforms?.["windows-x86_64"];
      if (!platform) {
        failures.push("latest.json 缺少 windows-x86_64");
      } else {
        if (platform.signature !== signature) {
          failures.push("latest.json 签名与本地 .sig 不一致");
        }
        let decoded = "";
        try {
          decoded = decodeURIComponent(String(platform.url ?? ""));
        } catch {
          decoded = String(platform.url ?? "");
        }
        if (!decoded.endsWith(basename(setup))) {
          failures.push("latest.json 下载 URL 未指向本地 setup.exe");
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error("release artifacts: FAIL");
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}

const summary = {
  generatedAt: new Date().toISOString(),
  version,
  setup: basename(setup),
  sizeBytes: size,
  sha256: digest,
  signatureLength: signature ? signature.length : 0,
  offlineWebView2Heuristic: size >= 120 * 1024 * 1024,
};

if (summaryPath) {
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

console.log("release artifacts: PASS");
console.log(`- ${summary.setup}`);
console.log(`- ${(size / 1024 / 1024).toFixed(1)} MiB`);
console.log(`- sha256 ${digest}`);
console.log(`- signature ${summary.signatureLength} chars`);
console.log(`- offline WebView2 heuristic: ${summary.offlineWebView2Heuristic ? "pass" : "unverified"}`);
