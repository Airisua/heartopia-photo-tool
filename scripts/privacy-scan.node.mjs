// Run with `node --test scripts/privacy-scan.node.mjs`.
// The filename intentionally avoids Vitest's default `*.test.mjs` glob, because
// that runner bundles the frontend in jsdom and cannot load `node:test`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectStagedFiles,
  normalizeKnownSecrets,
  readStagedFile,
  scanFileBuffer,
  scanRepository,
  scanText,
} from "./lib/privacy-scan.mjs";

const publicNoreply = "Airisua@users.noreply.github.com";

function categories(text, options = {}) {
  return scanText(text, options).map((finding) => finding.category);
}

function fakeGithubToken() {
  return `ghp_${"a".repeat(36)}`;
}

function fakeGithubPat() {
  return `github_pat_${"b".repeat(48)}`;
}

function fakeJwt() {
  return ["eyJhbGciOiJIUzI1NiJ9", "c".repeat(24), "d".repeat(24)].join(".");
}

function fakeAwsAccessKey() {
  return `AKIA${"A".repeat(16)}`;
}

function fakeAwsSecret() {
  return ["AWS_SECRET_ACCESS_KEY", "=", "B".repeat(40)].join(" ");
}

function fakePrivateKeyBlock() {
  return `${"-----BEGIN "}${"PRIVATE KEY-----"}\n${"e".repeat(32)}\n${"-----END PRIVATE KEY-----"}`;
}

function fakeKeyArray() {
  const values = Array.from({ length: 32 }, (_, index) => `0x${(index + 1).toString(16).padStart(2, "0")}`);
  return `const AES_KEY: [u8; 32] = [${values.join(", ")}];`;
}

function fakeWindowsPath(escaped = false) {
  return ["C:", "Users", "Alice"].join(escaped ? "\\\\" : "\\");
}

function fakeUnixPath() {
  return `/${"home"}/${"alice"}/Pictures`;
}

function fakePersonalEmail() {
  return ["mailbox", "gmail.com"].join("@");
}

function fakeScale() {
  return ["19", "775"].join(",");
}

function fakeSize() {
  return ["3.2", "GB"].join(" ");
}

function initGitRepo() {
  const directory = mkdtempSync(join(tmpdir(), "heartopia-privacy-"));
  const run = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("init", "-q");
  run("config", "user.name", "Privacy Test");
  run("config", "user.email", "privacy@example.com");
  return { directory, run };
}

test("detects GitHub tokens and PATs", () => {
  const text = `${fakeGithubToken()}\n${fakeGithubPat()}`;
  const result = categories(text, { path: "fixture.txt" });
  assert.equal(result.filter((value) => value === "github-token").length, 2);
});

test("detects JWT and bearer credentials", () => {
  const text = `${fakeJwt()}\nAuthorization: Bearer ${"f".repeat(32)}`;
  const result = categories(text);
  assert.ok(result.includes("jwt-token"));
  assert.ok(result.includes("bearer-token"));
});

test("detects AWS access and secret keys", () => {
  const text = `${fakeAwsAccessKey()}\n${fakeAwsSecret()}`;
  const result = categories(text);
  assert.ok(result.includes("aws-access-key"));
  assert.ok(result.includes("aws-secret-key"));
});

test("detects private key blocks", () => {
  assert.ok(categories(fakePrivateKeyBlock()).includes("private-key-block"));
});

test("detects Tauri signing material without exposing it", () => {
  const line = `TAURI_SIGNING_PRIVATE_KEY = "${"Z".repeat(64)}"`;
  const findings = scanText(line, { path: "fixture.env" });
  assert.ok(findings.some((finding) => finding.category === "signing-key-value"));
  assert.ok(!JSON.stringify(findings).includes("Z".repeat(64)));
});

test("detects Windows paths, including JSON-escaped forms", () => {
  const escaped = fakeWindowsPath(true);
  const result = categories(`${fakeWindowsPath()}\n${escaped}`);
  assert.equal(result.filter((value) => value === "private-user-path").length, 2);
  const unc = ["", "", "server", "Users", "Alice"].join("\\");
  assert.ok(categories(unc).includes("private-user-path"));
});

test("detects Unix user paths but not placeholder examples", () => {
  assert.ok(categories(fakeUnixPath()).includes("private-user-path"));
  assert.ok(!categories(`/${"home"}/${"example"}/Pictures`).includes("private-user-path"));
  const url = ["https://example.com", "home", "alice"].join("/");
  assert.ok(!categories(url).includes("private-user-path"));
});

test("rejects personal email but permits the public noreply address", () => {
  assert.ok(categories(fakePersonalEmail()).includes("personal-email"));
  assert.ok(!categories(publicNoreply).includes("personal-email"));
  assert.ok(!categories("owner@example.com").includes("personal-email"));
});

test("detects local scale and host fingerprints", () => {
  const result = categories(
    [`files: ${fakeScale()}`, `size: ${fakeSize()}`, ["Model", "ThinkPad X1 Carbon"].join(": ")].join(
      "\n",
    ),
  );
  assert.ok(result.includes("local-scale"));
  assert.ok(result.includes("host-detail"));
});

test("allows placeholders, public updater keys and environment names", () => {
  const text = [
    "password: <TOKEN>",
    ["TAURI_SIGNING_PRIVATE_KEY", ":", "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"].join(" "),
    "HEARTOPIA_CRYPTO_MATERIAL_B64: <从本地安全存储注入>",
    `pubkey: "${"dW50cnVzdGVk".repeat(4)}"`,
    "C:\\Users\\ExampleUser\\ScreenCapture",
    "/home/example/Pictures",
  ].join("\n");
  assert.deepEqual(categories(text), []);
});

test("allows generated icons but rejects arbitrary binary attachments", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.deepEqual(scanFileBuffer("src-tauri/icons/32x32.png", png), []);
  const finding = scanFileBuffer("docs/capture.png", png);
  assert.equal(finding[0]?.category, "binary-attachment");
  const textFinding = scanFileBuffer(
    "src-tauri/icons/notes.md",
    Buffer.from(fakeGithubToken(), "utf8"),
  );
  assert.equal(textFinding[0]?.category, "github-token");
});

test("does not honor whole-file bypass markers", () => {
  const marker = ["secret-scan:", "allow-file"].join(" ");
  const result = categories(`${marker}\n${fakeGithubToken()}`, { path: "fixture.txt" });
  assert.ok(result.includes("unsafe-scan-bypass"));
  assert.ok(result.includes("github-token"));
});

test("allows only a narrow synthetic-vector block", () => {
  const marker = ["privacy-scan:", "synthetic-vector"].join(" ");
  assert.ok(
    !categories(`${marker}\n${fakeKeyArray()}`, { path: "fixture.rs" }).includes(
      "raw-key-material",
    ),
  );
  assert.ok(categories(fakeKeyArray(), { path: "fixture.rs" }).includes("raw-key-material"));
});

test("matches configured known secrets without including them in findings", () => {
  const secret = ["known", "value", "without", "display"].join("-");
  const findings = scanText(`prefix ${secret} suffix`, { knownSecrets: [secret] });
  assert.ok(findings.some((finding) => finding.category === "known-secret"));
  assert.ok(!JSON.stringify(findings).includes(secret));
  assert.deepEqual(normalizeKnownSecrets([secret]), [secret]);
});

test("staged mode reads the index rather than the working copy", () => {
  const { directory, run } = initGitRepo();
  try {
    const file = join(directory, "staged.txt");
    writeFileSync(file, `${fakeGithubToken()}\n`, "utf8");
    run("add", "staged.txt");
    assert.deepEqual(collectStagedFiles(directory), ["staged.txt"]);
    assert.ok(readStagedFile(directory, "staged.txt")?.toString("utf8").includes("ghp_"));
    writeFileSync(file, "clean working copy\n", "utf8");
    const result = scanRepository({ root: directory, scope: "staged" });
    assert.ok(result.findings.some((finding) => finding.category === "github-token"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("history mode reports location categories without object IDs", () => {
  const { directory, run } = initGitRepo();
  try {
    const personal = fakePersonalEmail();
    writeFileSync(join(directory, "capture.txt"), `${fakeGithubToken()}\n`, "utf8");
    run("add", "capture.txt");
    run(
      "-c",
      `user.email=${personal}`,
      "-c",
      "user.name=History Test",
      "commit",
      "-q",
      "-m",
      "history fixture",
    );

    const result = scanRepository({ root: directory, scope: "history" });
    assert.ok(result.findings.some((finding) => finding.category === "github-token"));
    assert.ok(result.findings.some((finding) => finding.category === "personal-email"));
    assert.ok(!/[0-9a-f]{40,64}/i.test(JSON.stringify(result.findings)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
