"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { runProcess, runtime, request, registerMcp } = require("../../vscode-control/assistance-client");

function processFixture(action) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; };
  child.stdin.on("finish", () => action(child));
  return child;
}

test("provider evidence travels on stdin and MCP registration uses literal arguments", async () => {
  const calls = [], runtime = { command: "runtime", args: ["literal space"], env: { PLUGIN_DATA: "/private/data" },
    codexCommand: "codex", codexPrefix: [], binary: "/path with spaces/decision-hook", dataDirectory: "/private/data" };
  const result = await request(runtime, { workflow: "rank_context", query: "literal $(ignored)" }, { run: async (program, args, options) => {
    calls.push({ program, args, options }); return '{"advisory":true}';
  } });
  assert.equal(result.advisory, true);
  assert.deepEqual(calls[0].args, ["literal space", "--assist"]);
  assert.equal(calls[0].options.input.includes("$(ignored)"), true);
  await registerMcp(runtime, async (program, args) => { calls.push({ program, args }); });
  assert.deepEqual(calls[1].args, ["mcp", "add", "codex-decision", "--env", "PLUGIN_DATA=/private/data", "--", runtime.binary, "--mcp"]);
  await assert.rejects(request(runtime, {}, { run: async () => '{"advisory":true,"advisory":false}' }), /Duplicate/);
});

test("process deadlines, cancellation, and oversized output terminate the child without revealing diagnostics", async () => {
  let child = processFixture(c => { c.stderr.end("private provider diagnostic"); });
  await assert.rejects(runProcess("runtime", [], { timeout: 10, launch: () => child }), /timed out/);
  assert.equal(child.killed, true);
  child = processFixture(c => { c.stdout.write("x".repeat(1024 * 1024 + 1)); });
  await assert.rejects(runProcess("runtime", [], { launch: () => child }), /exceeded/);
  assert.equal(child.killed, true);
  const abort = new AbortController();
  child = processFixture(() => abort.abort());
  await assert.rejects(runProcess("runtime", [], { launch: () => child, signal: abort.signal }), /cancelled/);
  child = processFixture(c => { c.stdout.end('{"ok":true}'); c.emit("close", 0); });
  assert.equal(await runProcess("runtime", [], { launch: () => child }), '{"ok":true}');
});

test("Windows-to-WSL assistance uses the verified executable cache instead of extracted VSIX permissions", async () => {
  const reads = [];
  const options = { platform: "win32", installation: { decisionctl: "/home/test/.codex/cache/plugin/hooks/bin/linux-x86_64/decisionctl" },
    validatePath: async () => {}, io: { lstat: async name => {
      reads.push(name); return { isFile: () => true, isSymbolicLink: () => false };
    } }, run: async () => { throw Error("cached Linux paths need no conversion"); } };
  const result = await runtime("C:\\extension", "\\\\wsl.localhost\\Ubuntu\\home\\test\\data", options);
  assert.deepEqual(result.args, ["-d", "Ubuntu", "-e", "env", "PLUGIN_DATA=/home/test/data",
    "/home/test/.codex/cache/plugin/hooks/bin/linux-x86_64/decision-hook"]);
  assert.equal(reads[0], "\\\\wsl.localhost\\Ubuntu\\home\\test\\.codex\\cache\\plugin\\hooks\\bin\\linux-x86_64\\decision-hook");
  await assert.rejects(runtime("C:\\extension", "\\\\wsl.localhost\\Ubuntu\\home\\test\\data", { ...options, installation: null }), /Repair Integration/);
});
