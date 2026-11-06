"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeSelection } = require("../../../vscode-control/core");

test("invalid config and linked target fail without changing a hook selection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
  try {
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ enabled: "yes" }));
    await assert.rejects(writeSelection(directory, true), /Invalid Decision config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ test_build_enabled: "yes" }));
    await assert.rejects(writeSelection(directory, false), /Invalid Decision config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ search_listing_enabled: "yes" }));
    await assert.rejects(writeSelection(directory, false), /Invalid Decision config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ min_chars: 1 }));
    await assert.rejects(writeSelection(directory, true), /Invalid Decision config/);
    await fs.rm(path.join(directory, "config.json"));
    try {
      await fs.symlink(path.join(directory, "missing.json"), path.join(directory, "config.json"));
      await assert.rejects(writeSelection(directory, true));
    } catch (error) {
      if (error.code !== "EPERM") throw error; // Windows developer mode may forbid test symlinks.
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
