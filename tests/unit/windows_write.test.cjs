"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../vscode-control/core");

for (const persistent of [false, true]) {
  test(`Windows atomic writes ${persistent ? "preserve the old file on persistent denial" : "recover transient reader locks"}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-windows-write-"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const rename = fs.rename;
    try {
      await core.writeGlobalSettings(directory, { mode: "replace", log_limit_mb: 50 });
      const previous = await fs.readFile(path.join(directory, "settings.json"));
      let attempts = 0;
      Object.defineProperty(process, "platform", { value: "win32" });
      fs.rename = async (...args) => {
        attempts += 1;
        if (persistent || attempts <= 2) {
          assert.deepEqual(await fs.readFile(path.join(directory, "settings.json")), previous);
          const error = new Error("Synthetic Windows sharing denial");
          error.code = attempts % 2 === 1 ? "EPERM" : "EBUSY";
          throw error;
        }
        return rename(...args);
      };
      if (persistent) {
        await assert.rejects(core.writeGlobalSettings(directory, { mode: "observe" }),
          /Synthetic Windows sharing denial/);
        assert.equal(attempts, 6, "permanent failure must stop after bounded retries");
        assert.deepEqual(await fs.readFile(path.join(directory, "settings.json")), previous);
      } else {
        await core.writeGlobalSettings(directory, { mode: "observe" });
        assert.equal(attempts, 3);
        assert.equal((await core.readGlobalSettings(directory)).mode, "observe");
      }
      assert.deepEqual(await fs.readdir(directory), ["settings.json"],
        "successful and failed writes must remove their temporary file and lock");
    } finally {
      fs.rename = rename;
      Object.defineProperty(process, "platform", platform);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
