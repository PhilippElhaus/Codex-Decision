"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkHealth, readApiKey, writeApiKey } = require("../../vscode-control/core");

test("health probe classifies failed and malformed replies without exposing a key", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-health-edge-"));
  try {
    await writeApiKey(directory, "synthetic-key-123");
    const cases = [
      ["expired", async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ code: "key_expired" }) }), "JEV_KEY_EXPIRED"],
      ["unauthorized", async () => ({ ok: false, status: 401, text: async () => "denied" }), "JEV_HTTP_401"],
      ["forbidden", async () => ({ ok: false, status: 403, text: async () => "{}" }), "JEV_HTTP_403"],
      ["rate limited", async () => ({ ok: false, status: 429 }), "JEV_HTTP_429"],
      ["timeout", async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }, "JEV_TIMEOUT"],
      ["network", async () => { throw new Error("offline"); }, "JEV_NETWORK_ERROR"],
      ["missing response", async () => null, "JEV_INVALID_RESPONSE"],
      ["invalid body", async () => ({ ok: true, text: async () => "not JSON" }), "JEV_INVALID_RESPONSE"],
      ["oversized body", async () => ({ ok: true, text: async () => "x".repeat(262145) }), "JEV_INVALID_RESPONSE"],
      ["missing score", async () => ({ ok: true, text: async () => JSON.stringify({ model: "jev-1.13.0", answers: {} }) }), "JEV_INVALID_RESPONSE"],
    ];
    for (const [name, send, reason] of cases) {
      const result = await checkHealth(directory, send);
      assert.deepEqual(result, { ok: false, reason }, name);
      assert.equal(JSON.stringify(result).includes("synthetic-key-123"), false, name);
    }
    assert.equal(await readApiKey(directory), "synthetic-key-123");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("credential parser rejects duplicate and oversized values", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-key-edge-"));
  const filename = path.join(directory, ".env");
  try {
    await fs.writeFile(filename, "JEV_API_KEY=synthetic-one\nJEV_API_KEY=synthetic-two\n", { mode: 0o600 });
    await assert.rejects(readApiKey(directory), /missing or invalid/);
    await fs.writeFile(filename, `JEV_API_KEY=${"x".repeat(8192)}\n`, { mode: 0o600 });
    await assert.rejects(readApiKey(directory), /Unsafe/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
