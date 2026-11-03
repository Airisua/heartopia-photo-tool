#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCryptoMaterial } from "./lib/crypto-material.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const releaseMode = process.argv.includes("--release");
const ciMode = process.argv.includes("--ci") || !releaseMode;
const expectedRepo = "Airisua/heartopia-photo-tool";
const expectedManifest = `https://github.com/${expectedRepo}/releases/latest/download/latest.json`;
const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readText(relative) {
  const file = join(root, relative);
  if (!existsSync(file)) {
    fail(`缺少 ${relative}`);
    return null;
  }
  return readFileSync(file, "utf8");
}

function readJson(relative) {
  const text = readText(relative);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    fail(`${relative} 不是合法 JSON`);
    return null;
  }
}

function cargoPackageVersion(text) {
  if (!text) return null;
  const section = text.match(/^\[package\]\r?\n([\s\S]*?)(?=^\[)/m);
  if (!section) return null;
  const version = section[1].match(/^\s*version\s*=\s*"([^"]+)"/m);
  return version ? version[1] : null;
}

function isPlaceholder(value) {
  return (
    typeof value !== "string" ||
    value.trim().length < 40 ||
    /YOUR|PLACEHOLDER|PUBLICKEY|CHANGE_ME|TODO|\.\.\./i.test(value)
  );
}

function checkVersion(label, value, expected) {
  if (!value) {
    fail(`${label} 缺少 version`);
    return;
  }
  if (value !== expected) {
    fail(`${label} version=${value}，与 package.json ${expected} 不一致`);
  }
}

const pkg = readJson("package.json");
const conf = readJson("src-tauri/tauri.conf.json");
const cargoText = readText("src-tauri/Cargo.toml");
const lockExists = existsSync(join(root, "package-lock.json"));

if (!lockExists) {
  fail("缺少 package-lock.json；CI 使用 npm ci，必须先提交锁文件");
} else if (pkg) {
  const lock = readJson("package-lock.json");
  const lockVersion = lock?.packages?.[""]?.version;
  if (lockVersion !== pkg.version) {
    fail(`package-lock.json 版本=${lockVersion ?? "缺失"}，与 package.json ${pkg.version} 不一致`);
  }
}

if (pkg && conf) {
  checkVersion("src-tauri/tauri.conf.json", conf.version, pkg.version);
  checkVersion("src-tauri/Cargo.toml", cargoPackageVersion(cargoText), pkg.version);

  if (!conf.productName || typeof conf.productName !== "string") {
    fail("tauri.conf.json 缺少 productName");
  }
  if (!conf.identifier || conf.identifier === "com.tauri.dev") {
    fail("tauri.conf.json identifier 未设置或仍为默认值");
  } else if (!/^[A-Za-z0-9.-]+$/.test(conf.identifier)) {
    fail("tauri.conf.json identifier 只能包含字母、数字、点和连字符");
  }

  const bundle = conf.bundle ?? {};
  if (bundle.active !== true) fail("bundle.active 必须为 true");
  const targets = bundle.targets;
  if (!Array.isArray(targets) || !targets.includes("nsis")) {
    fail('bundle.targets 必须显式包含 "nsis"');
  }
  if (bundle.createUpdaterArtifacts !== true) {
    fail("bundle.createUpdaterArtifacts 必须为 true");
  }

  const icons = Array.isArray(bundle.icon) ? bundle.icon : [];
  if (!icons.some((entry) => typeof entry === "string" && entry.toLowerCase().endsWith(".ico"))) {
    fail("bundle.icon 必须包含 .ico 图标");
  }
  for (const icon of icons) {
    if (typeof icon === "string" && !isAbsolute(icon) && !existsSync(join(root, "src-tauri", icon))) {
      fail(`bundle.icon 文件不存在：${icon}`);
    }
  }

  const windows = bundle.windows ?? {};
  const webview = windows.webviewInstallMode ?? {};
  if (webview.type !== "offlineInstaller") {
    fail('bundle.windows.webviewInstallMode.type 必须为 "offlineInstaller"（干净机离线运行）');
  }
  if (webview.silent !== true) {
    fail("bundle.windows.webviewInstallMode.silent 必须为 true");
  }
  if (windows.allowDowngrades !== false) {
    fail("bundle.windows.allowDowngrades 必须显式设为 false");
  }
  const nsis = windows.nsis ?? {};
  if (nsis.installMode !== "currentUser") {
    fail('bundle.windows.nsis.installMode 必须为 "currentUser"（用户态安装与更新）');
  }

  const updater = conf.plugins?.updater ?? {};
  if (isPlaceholder(updater.pubkey)) {
    fail("plugins.updater.pubkey 未设置或仍是占位符");
  }
  if (updater.requireSignedVersion !== true) {
    fail("plugins.updater.requireSignedVersion 必须为 true（签名 trusted comment 版本绑定）");
  }
  if (updater.dangerousInsecureTransportProtocol === true) {
    fail("禁止启用 dangerousInsecureTransportProtocol");
  }
  const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
  if (!endpoints.includes(expectedManifest)) {
    fail(`plugins.updater.endpoints 必须包含 ${expectedManifest}`);
  }
  if (endpoints.some((entry) => typeof entry !== "string" || !entry.startsWith("https://"))) {
    fail("plugins.updater.endpoints 只能使用 HTTPS");
  }

  const csp = conf.app?.security?.csp;
  if (!csp || (typeof csp === "string" && csp.trim() === "")) {
    fail("app.security.csp 不能为空");
  }
  const cspText = typeof csp === "string" ? csp : JSON.stringify(csp ?? {});
  if (/unsafe-eval/i.test(cspText)) {
    fail("CSP 不得包含 unsafe-eval");
  }
  if (conf.app?.security?.dangerousDisableAssetCspModification === true) {
    fail("不得关闭 Tauri 的 CSP 资产修改保护");
  }

  const capabilityDir = join(root, "src-tauri", "capabilities");
  let capabilityText = "";
  if (!existsSync(capabilityDir)) {
    fail("缺少 src-tauri/capabilities");
  } else {
    capabilityText = readdirSync(capabilityDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFileSync(join(capabilityDir, name), "utf8"))
      .join("\n");
    for (const permission of ["dialog:allow-open", "dialog:allow-save"]) {
      if (!capabilityText.includes(permission)) {
        fail(`capabilities 缺少 ${permission}（目录/保存对话框需要）`);
      }
    }
  }

  const build = conf.build ?? {};
  if (!build.beforeBuildCommand || !/npm/.test(String(build.beforeBuildCommand))) {
    fail("build.beforeBuildCommand 必须执行前端构建");
  }
}

if (releaseMode) {
  const material = inspectCryptoMaterial(process.env.HEARTOPIA_CRYPTO_MATERIAL_B64);
  if (!material.valid) {
    fail(`发布构建 crypto material 无效（${material.reason}）`);
  }
  if (process.env.HEARTOPIA_RELEASE !== "1") {
    fail("发布构建必须设置 HEARTOPIA_RELEASE=1");
  }
} else {
  const material = inspectCryptoMaterial(process.env.HEARTOPIA_CRYPTO_MATERIAL_B64);
  if (material.present && !material.valid) {
    fail(`HEARTOPIA_CRYPTO_MATERIAL_B64 无效（${material.reason}）`);
  }
  if (ciMode) {
    warn("CI 模式：未验证发布密钥是否存在（由 Release workflow 强制）");
  }
}

const gitignore = readText(".gitignore") ?? "";
for (const entry of [".secrets/", ".env"]) {
  if (!gitignore.split(/\r?\n/).includes(entry)) {
    fail(`.gitignore 必须包含 ${entry}`);
  }
}

try {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "--cached"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split(/\r?\n/)
    .filter(Boolean);
  for (const path of tracked) {
    if (path === ".secrets" || path.startsWith(".secrets/")) {
      fail(`.secrets 不得被 Git 跟踪：${path}`);
    }
    if (path === ".env" || (path.startsWith(".env.") && path !== ".env.example")) {
      fail(`环境文件不得被 Git 跟踪：${path}`);
    }
  }
} catch {
  warn("无法读取 Git 索引；请在 Git 工作区内运行");
}

if (failures.length > 0) {
  console.error("release preflight: FAIL");
  for (const item of failures) console.error(`- ${item}`);
  for (const item of warnings) console.error(`! ${item}`);
  process.exit(1);
}

console.log("release preflight: PASS");
for (const item of warnings) console.log(`! ${item}`);
