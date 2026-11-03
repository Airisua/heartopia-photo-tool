import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareSummaryHash,
  downloadAndHash,
  fetchWithRetry,
  main,
  validateSummary,
} from "./verify-published-release.mjs";

const noSleep = async () => {};

function response(status, body = "", headers = {}) {
  return new Response(body, { status, headers });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function testSignature(version) {
  const envelope = [
    "untrusted comment: test",
    "AAAA",
    `trusted comment: timestamp:0\tfile:test\tversion:${version}`,
    "BBBB",
    "",
  ].join("\n");
  return Buffer.from(envelope, "utf8").toString("base64");
}

function testManifest(assetName) {
  return {
    version: "0.1.0",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: testSignature("0.1.0"),
        url: `https://github.com/owner/repo/releases/download/v0.1.0/${encodeURIComponent(assetName)}`,
      },
    },
  };
}

function stubFetch(manifest, payload) {
  return async (url, init = {}) => {
    if (String(url).endsWith("latest.json")) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (init.headers?.range) {
      return new Response(new Uint8Array([0]), { status: 206 });
    }
    return new Response(payload, {
      status: 200,
      headers: { "content-length": String(payload.length) },
    });
  };
}

async function writeSummary(directory, assetName, payload, digest) {
  const file = join(directory, "summary.json");
  await writeFile(
    file,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      version: "0.1.0",
      setup: assetName,
      sizeBytes: payload.length,
      sha256: digest,
    }),
    "utf8",
  );
  return file;
}

test("retries a transient 404 and then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls < 3 ? response(404) : response(200, "ok");
  };

  const result = await fetchWithRetry(
    "https://release.invalid/latest.json",
    {},
    { fetchImpl, attempts: 5, sleep: noSleep },
  );

  assert.equal(result.status, 200);
  assert.equal(calls, 3);
});

test("retries 403, 429 and 5xx within the bounded budget", async () => {
  const statuses = [403, 429, 503, 200];
  let calls = 0;
  const fetchImpl = async () => response(statuses[calls++]);

  const result = await fetchWithRetry(
    "https://release.invalid/asset",
    {},
    { fetchImpl, attempts: 5, sleep: noSleep },
  );

  assert.equal(result.status, 200);
  assert.equal(calls, 4);
});

test("a sustained 404 is bounded and remains a failure", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(404);
  };

  const result = await fetchWithRetry(
    "https://release.invalid/latest.json",
    {},
    { fetchImpl, attempts: 4, sleep: noSleep },
  );

  assert.equal(result.status, 404);
  assert.equal(calls, 4);
  assert.equal(result.ok, false);
});

test("a non-retryable 400 is returned on the first attempt", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(400);
  };

  const result = await fetchWithRetry(
    "https://release.invalid/asset",
    {},
    { fetchImpl, attempts: 5, sleep: noSleep },
  );

  assert.equal(result.status, 400);
  assert.equal(calls, 1);
});

test("recovers when a network error is followed by a response", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("connection reset");
    return response(200, "ok");
  };

  const result = await fetchWithRetry(
    "https://release.invalid/asset",
    {},
    { fetchImpl, attempts: 3, sleep: noSleep },
  );

  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test("network errors are bounded and surface the last error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("connection reset");
  };

  await assert.rejects(
    fetchWithRetry(
      "https://release.invalid/asset",
      {},
      { fetchImpl, attempts: 3, sleep: noSleep },
    ),
    /connection reset/,
  );
  assert.equal(calls, 3);
});

test("streams a chunked asset into sha256 without buffering it whole", async (t) => {
  const payload = randomBytes(256 * 1024);
  const server = createServer((_request, reply) => {
    reply.writeHead(200, { "content-type": "application/octet-stream" });
    reply.write(payload.subarray(0, 100_000));
    reply.end(payload.subarray(100_000));
  });
  const base = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  );

  const result = await downloadAndHash(`${base}/asset`, {
    attempts: 2,
    sleep: noSleep,
  });

  assert.equal(result.ok, true);
  assert.equal(result.bytes, payload.length);
  assert.equal(result.sha256, createHash("sha256").update(payload).digest("hex"));
});

test("retries a transient asset 404 and hashes the eventual body", async (t) => {
  const payload = Buffer.from("release-asset-body");
  let calls = 0;
  const server = createServer((_request, reply) => {
    calls += 1;
    if (calls < 3) {
      reply.writeHead(404);
      reply.end("missing");
      return;
    }
    reply.writeHead(200, { "content-length": payload.length });
    reply.end(payload);
  });
  const base = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  );

  const result = await downloadAndHash(`${base}/asset`, {
    attempts: 5,
    sleep: noSleep,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sha256, createHash("sha256").update(payload).digest("hex"));
  assert.equal(calls, 3);
});

test("a genuine 404 asset stops after the bounded attempts", async (t) => {
  let calls = 0;
  const server = createServer((_request, reply) => {
    calls += 1;
    reply.writeHead(404);
    reply.end("missing");
  });
  const base = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  );

  const result = await downloadAndHash(`${base}/missing`, {
    attempts: 3,
    sleep: noSleep,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(calls, 3);
});

test("summary metadata and hash binding", () => {
  const digest = "a".repeat(64);
  const summary = {
    version: "0.1.0",
    setup: "Heartopia Photo Tool_0.1.0_x64-setup.exe",
    sizeBytes: 123,
    sha256: digest,
  };

  assert.deepEqual(
    validateSummary(summary, { version: "0.1.0", assetName: summary.setup }),
    [],
  );
  assert.deepEqual(compareSummaryHash(summary, { sha256: digest, bytes: 123 }), []);
  assert.deepEqual(
    compareSummaryHash(summary, { sha256: digest.toUpperCase(), bytes: 123 }),
    [],
  );

  assert.equal(
    compareSummaryHash(summary, { sha256: "b".repeat(64), bytes: 123 }).length,
    1,
  );
  assert.equal(
    compareSummaryHash(summary, { sha256: digest, bytes: 124 }).length,
    1,
  );
  assert.equal(
    validateSummary(
      { ...summary, version: "0.1.1" },
      { version: "0.1.0", assetName: summary.setup },
    ).length,
    1,
  );
  assert.equal(
    validateSummary(
      { ...summary, setup: "other-setup.exe" },
      { version: "0.1.0", assetName: summary.setup },
    ).length,
    1,
  );
  assert.equal(
    validateSummary(
      { ...summary, sha256: "not-a-digest" },
      { version: "0.1.0", assetName: summary.setup },
    ).length,
    1,
  );
  assert.equal(
    validateSummary(
      { ...summary, sizeBytes: "123" },
      { version: "0.1.0", assetName: summary.setup },
    ).length,
    1,
  );
});

test("main accepts a matching --summary hash", async (t) => {
  const payload = Buffer.from("published-asset-body");
  const assetName = "Heartopia Photo Tool_0.1.0_x64-setup.exe";
  const digest = createHash("sha256").update(payload).digest("hex");
  const directory = await mkdtemp(join(tmpdir(), "release-verify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summaryPath = await writeSummary(directory, assetName, payload, digest);

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  globalThis.fetch = stubFetch(testManifest(assetName), payload);
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const code = await main(["--tag", "v0.1.0", "--summary", summaryPath], {});
    assert.equal(code, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }

  assert.ok(logs.some((line) => line.includes("published release: PASS")));
  assert.ok(logs.some((line) => line.includes("matches release-summary.json")));
});

test("main rejects a mismatched --summary hash", async (t) => {
  const payload = Buffer.from("published-asset-body");
  const assetName = "Heartopia Photo Tool_0.1.0_x64-setup.exe";
  const directory = await mkdtemp(join(tmpdir(), "release-verify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summaryPath = await writeSummary(directory, assetName, payload, "0".repeat(64));

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  globalThis.fetch = stubFetch(testManifest(assetName), payload);
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const code = await main(["--tag", "v0.1.0", "--summary", summaryPath], {});
    assert.equal(code, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }

  assert.ok(logs.some((line) => line.includes("published release: FAIL")));
  assert.ok(logs.some((line) => line.includes("sha256 与 release-summary.json 不一致")));
});
