"use strict";

// Loaded only by the disposable VSIX copy used by the native integration test.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const rawRun = promisify(execFile);
let testedRetry = false;

async function run(program, args, options) {
  let isolated = [...args];
  if (process.env.DECISION_INTEGRATED_TEST_MODE === "native" && program.toLowerCase() === "wsl.exe") {
    throw new Error("Native Windows integration must not invoke WSL");
  }
  if (program.toLowerCase() === "wsl.exe") {
    const index = isolated.indexOf("-e");
    if (index < 0) throw new Error("Native integration test requires an explicit WSL executable");
    const root = process.env.DECISION_INTEGRATED_TEST_LINUX;
    if (!/^\/tmp\/decision-vscode-integrated-[A-Za-z0-9]{8}$/.test(root || "")) {
      throw new Error("Invalid native integration fixture root");
    }
    if (isolated[index + 2] === "install") {
      isolated.push("--home", `${root}/home`);
      await temporaryFixtureFailure(async () => rawRun("wsl.exe",
        [...isolated.slice(0, index + 1), "touch", `${root}/home/startup-retry-verified`], options));
    }
    isolated.splice(index + 1, 0, "env", `CODEX_HOME=${root}/codex`,
      `DECISION_TEST_HOME=${root}/home`,
      `CODEX_DECISION_MARKETPLACE_PATH=${root}/home/.local/share/codex-decision/.agents/plugins/marketplace.json`);
  }
  if (process.env.DECISION_INTEGRATED_TEST_MODE === "native" && isolated[0] === "install") {
    const home = process.env.DECISION_INTEGRATED_TEST_HOME;
    isolated.push("--home", home);
    await temporaryFixtureFailure(() => require("node:fs/promises").writeFile(
      require("node:path").join(home, "startup-retry-verified"), "owned native startup failure fixture"));
  }
  return rawRun(program, isolated, options);
}

async function temporaryFixtureFailure(mark) {
  if (testedRetry) return;
  testedRetry = true;
  await mark();
  throw Object.assign(new Error("Synthetic temporary installer access failure"), { code: "EAGAIN" });
}

module.exports = { run };
