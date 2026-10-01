"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const test = require("node:test");
const core = require("../../vscode-control/core");
const { readLatestPanelDecision } = require("../../vscode-control/panel-state");

test("simultaneous settings updates preserve both changes, including separate processes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-writes-"));
  try {
    for (let i = 0; i < 10; i++) {
      await core.writeGlobalSettings(root, { mode: "replace", log_limit_mb: 50 });
      await Promise.all([core.writeGlobalSettings(root, { mode: "observe" }), core.writeGlobalSettings(root, { log_limit_mb: 123 })]);
      assert.equal((await core.readGlobalSettings(root)).mode, "observe");
      assert.equal((await core.readGlobalSettings(root)).log_limit_mb, 123);
    }
    await core.writeGlobalSettings(root, { mode: "replace", log_limit_mb: 50 });
    const script = 'require(process.argv[1]).writeGlobalSettings(process.argv[2], JSON.parse(process.argv[3])).catch(e=>{console.error(e.message);process.exitCode=1})';
    await Promise.all([{ mode: "observe" }, { log_limit_mb: 123 }].map(change => execFile(process.execPath,
      ["-e", script, path.resolve(__dirname, "../../vscode-control/core"), root, JSON.stringify(change)], { timeout: 5000 })));
    const saved = await core.readGlobalSettings(root);
    assert.equal(saved.mode, "observe"); assert.equal(saved.log_limit_mb, 123);
    assert.equal((await fs.readdir(root)).some(name => name.endsWith(".tmp") || name.endsWith(".lock")), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("config selections serialize against independent setting changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-config-writes-"));
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => core.writeSelection(root, i % 2 === 0, true, false)));
    const saved = await core.readConfig(root);
    assert.equal(saved.test_build_enabled, true); assert.equal(saved.search_listing_enabled, false);
    assert.equal((await fs.readdir(root)).some(name => name.endsWith(".tmp") || name.endsWith(".lock")), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("all state readers reject linked roots, ancestors and log directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-path-chain-"));
  try {
    const data = path.join(root, "data"); await fs.mkdir(data, { mode: 0o700 });
    const session = core.sessionDirectory(data, "thread"); await core.ensureSessionDefaults(session);
    const outside = path.join(root, "outside"); await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, path.join(session, "logs"));
    await assert.rejects(readLatestPanelDecision(session), /Unsafe/);
    await assert.rejects(core.readEventsSince(session, 0), /Unsafe/);
    await assert.rejects(core.readHookHealth(session), /Unsafe/);
    const linked = path.join(root, "linked"); await fs.symlink(data, linked);
    await assert.rejects(core.readGlobalSettings(linked), /Unsafe/);
    await assert.rejects(core.writeGlobalSettings(linked, { mode: "observe" }), /Unsafe/);
    await assert.rejects(core.readConfig(core.sessionDirectory(linked, "thread")), /Unsafe/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a real Fetch stream is cancelled at the health response limit", async () => {
  let cancelled = false;
  const result = await core.checkHealth("unused", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; },
  })), "synthetic-test-key");
  assert.equal(result.reason, "JEV_INVALID_RESPONSE"); assert.equal(cancelled, true);
});

test("the shared config contract accepts explicit global scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-contract-"));
  try {
    const config = JSON.parse(await fs.readFile(path.resolve(__dirname, "../../config.example.json"), "utf8"));
    config.scope = "global";
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(config));
    assert.equal((await core.readConfig(root)).scope, "global");
    config.scope = "session";
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(config));
    await assert.rejects(core.readConfig(root), /Invalid Jev config/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

 test("installation latency weights API timings rather than completed results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-timing-"));
  try {
    for (const [id, timed, completed, elapsedMs] of [["one", 4, 1, 400], ["two", 1, 1, 300]]) {
      const directory = core.sessionDirectory(root, id); await core.ensureSessionDefaults(directory);
      await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({ calls: timed, timed, completed, elapsedMs, replaced: 0, savedChars: 0 }));
    }
    const stats = await core.readInstallationStats(root); assert.equal(stats.averageMs, 140);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
