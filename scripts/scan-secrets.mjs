#!/usr/bin/env node
import { resolve } from "node:path";
import {
  loadKnownSecrets,
  repoRootFromModule,
  scanRepository,
} from "./lib/privacy-scan.mjs";

const root = repoRootFromModule();
const args = process.argv.slice(2);
let scope = "working";
let knownSecretsFile = null;

function usage() {
  console.error(
    [
      "用法: node scripts/scan-secrets.mjs [--staged|--history] [--known-secrets-file <path>]",
      "",
      "默认扫描工作树（已跟踪 + 未忽略文件）；--staged 只扫描暂存区；",
      "--history 扫描所有 refs 的历史 blob 和提交元数据。",
      "扫描结果只显示位置与类别，不显示匹配内容、对象 ID 或秘密值。",
    ].join("\n"),
  );
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--staged" || arg === "--history") {
    if (scope !== "working") {
      console.error("privacy scan: 只能选择一个扫描范围（--staged 或 --history）。");
      process.exit(2);
    }
    scope = arg.slice(2);
  } else if (arg === "--known-secrets-file") {
    const value = args[++index];
    if (!value) {
      console.error("privacy scan: --known-secrets-file 缺少路径。");
      process.exit(2);
    }
    knownSecretsFile = resolve(process.cwd(), value);
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    console.error("privacy scan: 不认识的参数（未回显参数内容）。");
    usage();
    process.exit(2);
  }
}

let knownSecrets = [];
if (knownSecretsFile) {
  try {
    knownSecrets = loadKnownSecrets(knownSecretsFile);
  } catch {
    console.error("privacy scan: 无法读取 known-secrets 文件；文件内容和路径不会显示。");
    process.exit(2);
  }
}

let result;
try {
  result = scanRepository({ root, scope, knownSecrets });
} catch {
  console.error("privacy scan: 扫描失败（未显示内部路径或对象信息）。");
  process.exit(2);
}

const scopeLabel =
  scope === "staged" ? "暂存区" : scope === "history" ? "Git 历史" : "工作树";

if (result.findings.length > 0) {
  console.error(
    `privacy scan: FAIL (${result.findings.length} 个问题；${scopeLabel})`,
  );
  for (const finding of result.findings) {
    console.error(
      `- ${finding.scope}:${finding.path}:${finding.line} [${finding.category}]`,
    );
  }
  console.error(
    "仅显示位置和类别，不显示匹配内容、对象 ID 或秘密值。请移除敏感信息；" +
      "不要使用 allow-file 或全文件豁免。",
  );
  process.exit(1);
}

console.log(`privacy scan: PASS (${scopeLabel}；未发现敏感信息)`);
