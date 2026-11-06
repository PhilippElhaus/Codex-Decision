"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { completeRelevancePolicy, sessionDirectory, readConfig, ensureSessionDefaults, readGlobalSettings, writeGlobalSettings } = require("../../../vscode-control/core");

test("global policy validates thresholds and saves independent of sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-global-policy-"));
  try {
    const session = sessionDirectory(root, "thread-one");
    await ensureSessionDefaults(session);
    const policy = completeRelevancePolicy({ relevant_max: 4 });
    await writeGlobalSettings(root, { mode: "observe", relevance_policy: policy,
      log_limit_mb: 9999, never_delete_logs: true });
    const saved = await readGlobalSettings(root);
    assert.deepEqual(saved.relevance_policy, policy);
    assert.equal(saved.never_delete_logs, true);
    assert.equal((await readConfig(session)).mode, "replace");
    for (const changes of [
      { relevance_policy: { relevant_max: 101 } },
      { relevance_policy: { typo: 80 } },
      { relevance_policy: { exact_max: 101 } },
      { log_limit_mb: 0 }, { never_delete_logs: "true" },
    ]) await assert.rejects(writeGlobalSettings(root, changes));
    assert.deepEqual(await readGlobalSettings(root), saved);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
