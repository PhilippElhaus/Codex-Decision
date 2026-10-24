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

test("credential writes secure the temporary inode through the shared dotted-WSL helper before publication", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-credential-permission-"));
  const helperPath = require.resolve("../../vscode-control/private-paths");
  const corePath = require.resolve("../../vscode-control/core");
  const helpers = require(helperPath);
  const previousCore = require.cache[corePath];
  const calls = [];
  let denied = false;
  // Load the public credential writer with a bounded permission-helper stand-in.
  // The real helper still parses and prepares the selected dotted distribution;
  // its process transport stays mocked so this test never launches WSL.
  require.cache[helperPath].exports = { ...helpers, restrictWslPath: async (filename, isDirectory) => {
    if (isDirectory) return helpers.restrictWslPath(filename, true);
    assert.match(path.basename(filename), /^\.env-[0-9a-f-]+\.tmp$/);
    assert.equal((await fs.stat(filename)).isFile(), true);
    calls.push(filename);
    await helpers.restrictWslPath(`\\\\wsl.localhost\\Ubuntu-24.04\\home\\fixture\\${path.basename(filename)}`,
      false, async (command, args) => {
        assert.equal(command, "wsl.exe");
        assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu-24.04", "-e", "python3", "-c"]);
        assert.equal(args.at(-1), "file");
        if (denied) throw new Error("synthetic permission failure");
      }, "win32");
  } };
  let isolated;
  try {
    delete require.cache[corePath];
    isolated = require(corePath);
  } finally {
    require.cache[helperPath].exports = helpers;
    require.cache[corePath] = previousCore;
  }
  try {
    await isolated.writeApiKey(directory, "synthetic-initial-key");
    assert.equal(calls.length, 1);
    const target = path.join(directory, ".env");
    const previous = await fs.readFile(target);
    denied = true;
    await assert.rejects(isolated.writeApiKey(directory, "synthetic-replacement-key"), /Could not secure Decision state in WSL/);
    assert.equal(calls.length, 2);
    assert.deepEqual(await fs.readFile(target), previous,
      "permission failure must preserve the previously published credential file");
    assert.deepEqual(await fs.readdir(directory), [".env"], "failed writes must remove their owned temporary file and lock");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
