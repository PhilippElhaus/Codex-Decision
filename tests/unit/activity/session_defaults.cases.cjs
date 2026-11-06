"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { sessionDirectory, readConfig, writeSelection, ensureSessionDefaults, readGlobalSettings, writeGlobalSettings, readInstallationStats } = require("../../../vscode-control/core");

test("global settings stay independent of session switches and aggregate activity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-global-settings-"));
  try {
    const one = sessionDirectory(root, "one");
    const two = sessionDirectory(root, "two");
    await ensureSessionDefaults(one);
    await ensureSessionDefaults(two);
    await writeSelection(one, false);
    await writeGlobalSettings(root, { mode: "observe", log_limit_mb: 72 });
    assert.equal((await readGlobalSettings(root)).mode, "observe");
    assert.equal((await readGlobalSettings(root)).log_limit_mb, 72);
    assert.equal((await readConfig(one)).enabled, false);
    assert.equal((await readConfig(two)).enabled, true);
    assert.equal((await readConfig(one)).mode, "replace");
    for (const [directory, calls, completed, elapsedMs] of [[one, 2, 2, 200], [two, 1, 1, 300]]) {
      await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
        counter_scheme: directory === one ? 1 : undefined,
        calls, completed, replaced: 1, savedChars: 40, timed: completed, elapsedMs,
      }));
    }
    const totals = await readInstallationStats(root);
    assert.equal(totals.calls, 3);
    assert.equal(totals.replaced, 2);
    assert.equal(totals.averageMs, null, "legacy timing scope cannot become a request average in installation totals");
    assert.equal(totals.timed, 3);
    assert.equal(totals.elapsedMs, 500, "raw legacy timing counters are preserved");
    await assert.rejects(writeGlobalSettings(root, { log_limit_mb: 0 }), /Invalid Decision settings/);
    assert.equal((await readGlobalSettings(root)).log_limit_mb, 72);
    await fs.rm(path.join(root, "settings.json"));
    await t.test("linked settings files are rejected", async (t) => {
      try {
        await fs.symlink(path.join(one, "config.json"), path.join(root, "settings.json"));
      } catch (error) {
        if (process.platform !== "win32" || error.code !== "EPERM") throw error;
        t.skip("Windows file symlinks require Developer Mode or elevation");
        return;
      }
      await assert.rejects(readGlobalSettings(root), /Unsafe Decision settings file/);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("new Codex sessions enable Decision once and preserve later choices", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-default-session-"));
  const first = sessionDirectory(root, "thread-one");
  const second = sessionDirectory(root, "thread-two");
  try {
    const created = await ensureSessionDefaults(first);
    assert.equal(created.enabled, true);
    await writeSelection(first, false);
    assert.equal((await ensureSessionDefaults(first)).enabled, false);
    assert.equal((await ensureSessionDefaults(second)).enabled, true);
    assert.equal((await readConfig(first)).enabled, false);
    await assert.rejects(ensureSessionDefaults(root), /session directory/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
