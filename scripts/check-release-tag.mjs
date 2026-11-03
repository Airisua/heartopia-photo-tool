#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const index = args.indexOf("--tag");
const tag = index >= 0 ? args[index + 1] : null;
if (!tag) {
  console.error("用法: node scripts/check-release-tag.mjs --tag v0.1.0");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tagVersion = tag.replace(/^v/, "");
if (tagVersion !== pkg.version) {
  console.error(`发布 Tag ${tag} 与 package.json 版本 ${pkg.version} 不一致`);
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tagVersion)) {
  console.error("Tag 不是合法 SemVer");
  process.exit(1);
}

console.log(`release tag: PASS (${tag})`);
