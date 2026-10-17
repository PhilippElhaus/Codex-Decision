"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensureIntegratedInstall } = require("../../vscode-control/integrated-install");

async function fixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-integrated-test-"));
  try {
    const manifest = path.join(root, "plugin", ".codex-plugin", "plugin.json");
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, "{}");
    return await operation(root);
  } finally { await fs.rm(root, { recursive: true }); }
}

function vscodeStub(root) {
  const updates = [];
  return {
    updates, ConfigurationTarget: { Global: 1 },
    extensions: { getExtension: () => ({ extensionPath: path.join(root, "Codex host with spaces") }) },
    workspace: { getConfiguration: () => ({ update: async (...args) => { updates.push(args); } }) },
  };
}

const installed = { status: "ready", dataDirectory: "/home/alex/.codex/plugins/data/codex-decision-personal",
  decisionctl: "/home/alex/.codex/plugins/cache/personal/codex-decision/1.0.0/hooks/bin/linux-x86_64/decisionctl" };

test("integrated install discovers storage only when the setting is blank", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  const calls = [];
  const run = async (...args) => { calls.push(args); return { stdout: JSON.stringify(installed) }; };
  const result = await ensureIntegratedInstall(vscode, { extensionPath: root }, { platform: "linux", run });
  assert.equal(result.status, "ready");
  assert.deepEqual(vscode.updates, [["dataDirectory", installed.dataDirectory, 1]]);
  assert.equal(calls[0][0], "python3");
  assert.ok(calls[0][1].includes(path.join(root, "Codex host with spaces", "bin", "linux-x86_64", "codex")));
  vscode.updates.length = 0;
  await ensureIntegratedInstall(vscode, { extensionPath: root },
    { platform: "linux", run, dataDirectory: installed.dataDirectory });
  assert.deepEqual(vscode.updates, []);
  assert.deepEqual(calls[1][1].slice(-2), ["--data-directory", installed.dataDirectory]);
}));

test("Windows bootstrap selects the configured WSL distribution and passes each path as an argument", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  const calls = [];
  const configured = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alex\\.codex\\plugins\\data\\codex-decision-personal";
  const run = async (binary, args) => {
    calls.push({ binary, args });
    if (args[3] === "wslpath") return { stdout: `/mnt/c/converted/${path.basename(args[5])}\n` };
    return { stdout: JSON.stringify(installed) };
  };
  const result = await ensureIntegratedInstall(vscode, { extensionPath: root },
    { platform: "win32", run, dataDirectory: configured });
  assert.equal(result.distro, "Ubuntu-24.04");
  assert.equal(result.dataDirectory, configured);
  assert.ok(calls.every(({ binary, args }) => binary === "wsl.exe" && args[0] === "-d" && args[1] === "Ubuntu-24.04"));
  const install = calls.find(({ args }) => args[3] === "python3");
  assert.deepEqual(install.args.slice(-2), ["--data-directory", installed.dataDirectory]);
  assert.deepEqual(vscode.updates, []);
}));

test("Windows fresh bootstrap discovers default WSL and stores the matching UNC path", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  const run = async (_binary, args) => {
    if (args[0] === "-e") return { stdout: "Ubuntu-24.04\n" };
    if (args[3] === "wslpath") return { stdout: `/mnt/c/converted/${path.basename(args[5])}\n` };
    return { stdout: JSON.stringify(installed) };
  };
  await ensureIntegratedInstall(vscode, { extensionPath: root }, { platform: "win32", run });
  assert.deepEqual(vscode.updates, [["dataDirectory",
    "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alex\\.codex\\plugins\\data\\codex-decision-personal", 1]]);
}));

test("installer errors cannot copy raw subprocess diagnostics into the control", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  await assert.rejects(ensureIntegratedInstall(vscode, { extensionPath: root }, { platform: "linux",
    run: async () => { throw Object.assign(new Error("unrelated diagnostics"),
      { stdout: JSON.stringify({ status: "error", error: "Decision dataDirectory does not match the active Codex plugin; correct it before repair" }) }); } }),
  /dataDirectory does not match/);
  assert.deepEqual(vscode.updates, []);
}));

test("only an explicit transient installer failure authorizes automatic recovery", async () => fixture(async (root) => {
  for (const retryable of [true, false, "true", undefined]) {
    await assert.rejects(ensureIntegratedInstall(vscodeStub(root), { extensionPath: root }, { platform: "linux",
      run: async () => { throw Object.assign(new Error("private subprocess details"), {
        stdout: JSON.stringify({ status: "error", error: "sanitized installation failure", retryable }),
        stderr: "private environment must not appear" }); } }), (error) => {
      assert.equal(error.message, "sanitized installation failure");
      assert.equal(error.retryable, retryable === true);
      return true;
    });
  }
}));

test("temporary WSL discovery, path conversion, and installer transport failures stay retryable", async () => fixture(async (root) => {
  const configured = "\\\\wsl.localhost\\Ubuntu\\home\\alex\\.codex\\plugins\\data\\codex-decision-personal";
  for (const phase of ["discovery", "conversion", "installation"]) {
    for (const cause of [{ code: "EAGAIN" }, { code: "ETIMEDOUT" }, { code: null, killed: true, signal: "SIGTERM" }]) {
      await assert.rejects(ensureIntegratedInstall(vscodeStub(root), { extensionPath: root }, {
        platform: "win32", dataDirectory: phase === "discovery" ? "" : configured,
        run: async (_program, args) => {
          const actual = args[0] === "-e" ? "discovery" : args[3] === "wslpath" ? "conversion" : "installation";
          if (actual === phase) throw Object.assign(new Error("private process arguments"), {
            ...cause, stdout: "private stdout", stderr: "private stderr" });
          if (actual === "discovery") return { stdout: "Ubuntu\n" };
          if (actual === "conversion") return { stdout: "/mnt/c/converted\n" };
          return { stdout: JSON.stringify(installed) };
        },
      }), (error) => {
        assert.equal(error.retryable, true);
        const label = phase === "discovery" ? "WSL discovery" : phase === "conversion" ? "WSL path conversion" : "hook installer";
        assert.equal(error.message, `Decision installation is temporarily unavailable during ${label}; check WSL availability`);
        return true;
      });
    }
  }
}));

test("deterministic WSL discovery and conversion failures discard raw process diagnostics", async () => fixture(async (root) => {
  for (const phase of ["discovery", "conversion"]) {
    for (const code of [1, "ENOENT", "EACCES"]) {
      await assert.rejects(ensureIntegratedInstall(vscodeStub(root), { extensionPath: root }, {
        platform: "win32", dataDirectory: phase === "discovery" ? "" : "\\\\wsl.localhost\\Ubuntu\\home\\alex\\data",
        run: async () => { throw Object.assign(new Error("private process arguments"), {
          code, stdout: "private stdout", stderr: "private stderr", env: { KEY: "private key" } }); },
      }), (error) => {
        const label = phase === "discovery" ? "WSL discovery" : "WSL path conversion";
        assert.equal(error.message, `Decision installation failed during ${label}; check WSL availability and file access`);
        assert.notEqual(error.retryable, true);
        assert.equal(error.stdout, undefined);
        assert.equal(error.stderr, undefined);
        return true;
      });
    }
  }
}));

test("source-only test activation does not install a hook", async () => {
  const result = await ensureIntegratedInstall({}, { extensionUri: {} },
    { run: async () => { throw new Error("must not run"); } });
  assert.deepEqual(result, { status: "not-packaged" });
});
