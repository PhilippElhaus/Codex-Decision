"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkHealth, completeRelevancePolicy, sessionDirectory, readHookHealth, readApiKey, readConfig, readEventOffset, readLifetimeStats, writeApiKey } = require("../../../vscode-control/core");
const withV3 = (config) => require("../../../vscode-control/schema").validate("config", {
  ...config, schema_version: 4, relevance_policy: completeRelevancePolicy(),
});

test("session readers reject linked directories before opening state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-session-path-"));
  try {
    await fs.mkdir(path.join(root, "sessions"), { mode: 0o700 });
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(path.join(outside, "config.json"), JSON.stringify(withV3({
      enabled: true, mode: "replace",
    })));
    const linked = sessionDirectory(root, "linked-window");
    await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readConfig(linked), /Unsafe Decision session directory/);
    await assert.rejects(readHookHealth(linked), /Unsafe Decision session directory/);
    await assert.rejects(readLifetimeStats(linked), /Unsafe Decision session directory/);
    await assert.rejects(readEventOffset(linked), /Unsafe Decision session directory/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
