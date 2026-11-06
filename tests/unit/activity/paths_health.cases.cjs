"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { sessionDirectory, readHookHealth } = require("../../../vscode-control/core");

test("session paths are stable, separate, and reject unsafe IDs", async () => {
  const root = path.join(os.tmpdir(), "jev-data");
  const first = sessionDirectory(root, "session-one");
  const second = sessionDirectory(root, "session-two");
  assert.notEqual(first, second);
  assert.equal(first, sessionDirectory(root, "session-one"));
  assert.ok(first.startsWith(path.join(root, "sessions") + path.sep));
  for (const invalid of ["", "../escape", "contains space", 5, "a".repeat(129)]) {
    assert.throws(() => sessionDirectory(root, invalid), /session ID/);
  }
});

test("hook health is private, bounded, and rejects corrupt or linked data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-hook-health-"));
  try {
    assert.equal(await readHookHealth(directory), null);
    const logs = path.join(directory, "logs");
    await fs.mkdir(logs);
    const file = path.join(logs, "hook-health.json");
    const valid = { version: 1, hook_version: "0.8.0", last_seen_ms: Date.now(), last_skip: "small", skipped: 3 };
    await fs.writeFile(file, JSON.stringify(valid));
    assert.deepEqual(await readHookHealth(directory), valid);
    await fs.writeFile(file, JSON.stringify({ ...valid, skipped: -1 }));
    await assert.rejects(readHookHealth(directory), /Invalid Decision unsigned counter token/);
    await fs.writeFile(file, JSON.stringify({ ...valid, last_error_ms: -1 }));
    await assert.rejects(readHookHealth(directory), /Invalid Decision unsigned counter token/);
    await fs.writeFile(file, JSON.stringify({ ...valid, last_seen_ms: Date.now() + 600_000 }));
    await assert.rejects(readHookHealth(directory), /Invalid Decision hook health/);
    await fs.writeFile(file, "x".repeat(5000));
    await assert.rejects(readHookHealth(directory), /Unsafe Decision hook health/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
