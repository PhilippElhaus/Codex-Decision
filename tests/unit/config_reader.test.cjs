"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readConfig, readGlobalSettings, writeSelection, writeGlobalSettings } = require("../../vscode-control/core");
const { defaults } = require("../../vscode-control/schema");

test("control configuration rejects the same duplicate and corrupt UTF8 records as the hook without rewriting them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-config-codec-"));
  try {
    const cases = [
      ["config.json", { ...defaults("config"), enabled: true }, '"enabled":false,',
        readConfig, directory => writeSelection(directory, false)],
      ["settings.json", defaults("settings"), '"mode":"observe",',
        readGlobalSettings, directory => writeGlobalSettings(directory, { mode: "observe" })],
    ];
    for (const [name, valid, duplicate, read, write] of cases) {
      const target = path.join(root, name);
      const text = JSON.stringify(valid);
      // Put an invalid byte inside a JSON string; UTF8 replacement decoding
      // would silently accept it before schema validation.
      const corrupt = Buffer.from(text.replace("replace", "replacX"));
      corrupt[corrupt.indexOf(Buffer.from("replacX")) + 6] = 0xff;
      const invalid = [Buffer.from("{" + duplicate + text.slice(1)), corrupt];
      for (const bytes of invalid) {
        await fs.writeFile(target, bytes);
        await assert.rejects(read(root));
        await assert.rejects(write(root));
        assert.deepEqual(await fs.readFile(target), bytes);
      }
      await fs.writeFile(target, text);
      assert.equal((await read(root)).mode, "replace");
    }
  } finally {
    for (const entry of await fs.readdir(root)) {
      assert.ok(["config.json", "settings.json"].includes(entry));
      assert.equal((await fs.lstat(path.join(root, entry))).isSymbolicLink(), false);
    }
    await fs.rm(root, { recursive: true });
  }
});
