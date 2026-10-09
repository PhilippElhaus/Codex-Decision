"use strict";

// Loaded only by the disposable VSIX copy used by the native integration test.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const rawRun = promisify(execFile);

async function run(program, args, options) {
  let isolated = [...args];
  if (program.toLowerCase() === "wsl.exe") {
    const index = isolated.indexOf("-e");
    if (index < 0) throw new Error("Native integration test requires an explicit WSL executable");
    const root = process.env.DECISION_INTEGRATED_TEST_LINUX;
    if (!/^\/tmp\/decision-vscode-integrated-[A-Za-z0-9]{8}$/.test(root || "")) {
      throw new Error("Invalid native integration fixture root");
    }
    isolated.splice(index + 1, 0, "env", `CODEX_HOME=${root}/codex`,
      `DECISION_TEST_HOME=${root}/home`,
      `CODEX_DECISION_MARKETPLACE_PATH=${root}/home/.local/share/codex-decision/.agents/plugins/marketplace.json`);
  }
  return rawRun(program, isolated, options);
}

module.exports = { run };
