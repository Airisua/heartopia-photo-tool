#!/usr/bin/env node
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { signatureVersionMatches } from "./lib/signature.mjs";

const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function required(name) {
  const value = option(name);
  if (!value) {
    console.error(`缺少参数 ${name}`);
    process.exit(2);
  }
  return value;
}

const setup = required("--setup");
const sig = required("--sig");
const version = required("--version").replace(/^v/, "");
const tag = option("--tag", `v${version}`);
const repo = option("--repo", "Airisua/heartopia-photo-tool");
const output = option("--output", "artifacts/latest.json");
const notes = option("--notes", "见仓库 CHANGELOG 与 docs/USAGE.md。");
const notesFile = option("--notes-file");

for (const [label, file] of [
  ["安装包", setup],
  ["签名", sig],
]) {
  if (!existsSync(file)) {
    console.error(`${label}不存在：${file}`);
    process.exit(1);
  }
}

if (tag.replace(/^v/, "") !== version) {
  console.error("--tag 与 --version 不一致");
  process.exit(1);
}

const signature = readFileSync(sig, "utf8").trim();
if (signature.length < 40 || !/^[A-Za-z0-9+/=\r\n]+$/.test(signature)) {
  console.error("签名文件为空或格式不合法");
  process.exit(1);
}
const versionCheck = signatureVersionMatches(signature, version);
if (!versionCheck.ok) {
  console.error(`签名未绑定版本：${versionCheck.reason}`);
  process.exit(1);
}

const setupName = basename(setup);
if (!setupName.toLowerCase().endsWith("-setup.exe")) {
  console.error("安装包必须是 NSIS *-setup.exe");
  process.exit(1);
}
if (!setupName.includes(version)) {
  console.error("安装包文件名未包含版本号");
  process.exit(1);
}
if (statSync(setup).size < 100 * 1024 * 1024) {
  console.error("安装包小于 100 MiB；离线 WebView2 构建通常不应如此，拒绝生成误导性 manifest");
  process.exit(1);
}

let body = notes;
if (notesFile) {
  if (!existsSync(notesFile)) {
    console.error("--notes-file 不存在");
    process.exit(1);
  }
  body = readFileSync(notesFile, "utf8").trim();
  if (body.length > 8000) {
    console.error("更新说明超过 8000 字符");
    process.exit(1);
  }
}

const manifest = {
  version,
  notes: body,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(setupName)}`,
    },
  },
};

writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log("release manifest: PASS");
console.log(`- ${output}`);
console.log(`- version ${version}`);
console.log(`- windows-x86_64 signature length ${signature.length}`);
