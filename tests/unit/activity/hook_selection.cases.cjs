"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { completeRelevancePolicy, sessionDirectory, readConfig, writeSelection, ensureSessionDefaults, readGlobalSettings, writeGlobalSettings, readInstallationStats } = require("../../../vscode-control/core");
const withV3 = (config) => require("../../../vscode-control/schema").validate("config", {
  ...config, schema_version: 4, relevance_policy: completeRelevancePolicy(),
});

test("hook selection writes the config atomically and preserves the Decision mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
  try {
    assert.deepEqual(await readConfig(directory), { enabled: false, mode: "replace" });
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(withV3({ enabled: false, mode: "replace", min_chars: 10000 })));
    assert.deepEqual(await writeSelection(directory, true), withV3({ enabled: true, mode: "replace", min_chars: 10000 }));
    assert.deepEqual(await readConfig(directory), withV3({ enabled: true, mode: "replace", min_chars: 10000 }));
    assert.equal((await writeSelection(directory, false)).enabled, false);
    await assert.rejects(writeSelection(directory, "yes"), /boolean/);
    await writeSelection(directory, false);
    assert.equal((await readConfig(directory)).enabled, false);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["config.json"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("outdated configuration is rejected without changing it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-current-config-"));
  try {
    for (const outdated of [
      { enabled: true, precompact_enabled: true },
      { enabled: true, sample_chars: 12000 },
      { schema_version: 1, enabled: true },
    ]) {
      const bytes = JSON.stringify(outdated);
      await fs.writeFile(path.join(directory, "config.json"), bytes);
      await assert.rejects(readConfig(directory), /Invalid Decision config/);
      await assert.rejects(writeSelection(directory, true), /Invalid Decision config/);
      assert.equal(await fs.readFile(path.join(directory, "config.json"), "utf8"), bytes);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
