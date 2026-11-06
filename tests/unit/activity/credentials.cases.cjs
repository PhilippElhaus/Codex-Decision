"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkHealth, readApiKey, writeApiKey } = require("../../../vscode-control/core");

test("settings save private key and test an unsaved key without exposing it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-settings-test-"));
  try {
    await writeApiKey(directory, "saved-key-123");
    assert.equal(await readApiKey(directory), "saved-key-123");
    const result = await checkHealth(directory, async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer draft-key-456");
      return { ok: true, text: async () => JSON.stringify({ model: "gpt-6-luna", answers: [{name:"ready", type:"predicate", probability:0.9}] }) };
    }, "draft-key-456");
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes("draft-key-456"), false);
    assert.equal(await readApiKey(directory), "saved-key-123");
    await writeApiKey(directory, "updated-key-789");
    assert.equal(await readApiKey(directory), "updated-key-789");
    await assert.rejects(writeApiKey(directory, "bad key"), /invalid/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
