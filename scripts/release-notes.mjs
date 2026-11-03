#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const version = option("--version")?.replace(/^v/, "");
const source = option("--file", "CHANGELOG.md");
const output = option("--output", "artifacts/release-notes.md");
const githubOutput = args.includes("--github-output");

if (!version) {
  console.error("用法: node scripts/release-notes.mjs --version 0.1.0 [--file CHANGELOG.md]");
  process.exit(2);
}
if (!existsSync(source)) {
  console.error(`找不到 ${source}`);
  process.exit(1);
}

const text = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
const heading = `## [${version}]`;
const start = text.indexOf(heading);
if (start < 0) {
  console.error(`CHANGELOG 中缺少 ${heading}；发布前必须写更新说明`);
  process.exit(1);
}

const next = text.indexOf("\n## [", start + heading.length);
const section = (next >= 0 ? text.slice(start, next) : text.slice(start)).trim();
const linkDefinitions = section.search(/\n\[[^\]]+\]:\s+https?:/);
const body = (linkDefinitions >= 0 ? section.slice(0, linkDefinitions) : section).trim();

if (body.length < 20) {
  console.error("更新说明过短；请补充实际变更");
  process.exit(1);
}
if (body.length > 8000) {
  console.error("更新说明超过 8000 字符");
  process.exit(1);
}

writeFileSync(output, `${body}\n`, "utf8");

if (githubOutput) {
  if (!process.env.GITHUB_OUTPUT) {
    console.error("--github-output 需要 GITHUB_OUTPUT 环境变量");
    process.exit(1);
  }
  const delimiter = "HEARTOPIA_RELEASE_NOTES_EOF";
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `body<<${delimiter}\n${body}\n${delimiter}\n`,
    "utf8",
  );
}

console.log("release notes: PASS");
console.log(`- ${output} (${body.length} chars)`);
