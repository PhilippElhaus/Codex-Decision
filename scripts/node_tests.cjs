"use strict";
// Node receives literal entrypoint filenames on every platform.
// Imported .cases.cjs concerns keep their original worker and register once.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");

function discover(directory = path.join(ROOT, "tests")) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Linked test entry");
    if (entry.isDirectory()) return discover(filename);
    return entry.isFile() && entry.name.endsWith(".test.cjs") ? [filename] : [];
  }).sort();
}

if (require.main === module) {
  const files = discover();
  if (!files.length) throw new Error("No Node tests discovered");
  const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files],
    { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
module.exports = { discover };
