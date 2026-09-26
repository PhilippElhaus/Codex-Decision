"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  checkHealth, decisionSummary, parseHealthOutput, readConfig, readLatestEvent, writeEnabled,
} = require("../core");

test("hook selection writes the config atomically and preserves the pilot mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    assert.deepEqual(await readConfig(directory), { enabled: false, mode: "observe" });
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ mode: "replace", min_chars: 10000 }));
    assert.deepEqual(await writeEnabled(directory, true), { enabled: true, mode: "replace", min_chars: 10000 });
    assert.deepEqual(await readConfig(directory), { enabled: true, mode: "replace", min_chars: 10000 });
    await writeEnabled(directory, false);
    assert.equal((await readConfig(directory)).enabled, false);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["config.json"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("invalid config and linked target fail without changing a hook selection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ enabled: "yes" }));
    await assert.rejects(writeEnabled(directory, true), /Invalid pilot config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ min_chars: 1 }));
    await assert.rejects(writeEnabled(directory, true), /Invalid pilot config/);
    await fs.rm(path.join(directory, "config.json"));
    try {
      await fs.symlink(path.join(directory, "missing.json"), path.join(directory, "config.json"));
      await assert.rejects(writeEnabled(directory, true));
    } catch (error) {
      if (error.code !== "EPERM") throw error; // Windows developer mode may forbid test symlinks.
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("recent decision is read from a bounded log tail", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    const file = path.join(directory, "events.jsonl");
    await fs.writeFile(file, "x".repeat(40000) + "\n" +
      JSON.stringify({ tool: "Bash", status: "replace", reason: "jev_replace", original_chars: 12345, elapsed_ms: 480 }) + "\n" +
      JSON.stringify({ tool: "Bash", status: "skip", reason: "small", original_chars: 42, elapsed_ms: 0 }) + "\n");
    const event = await readLatestEvent(directory);
    assert.equal(event.reason, "small");
    const decision = await readLatestEvent(directory, { informativeOnly: true });
    assert.equal(decision.status, "replace");
    assert.match(decisionSummary(decision), /replaced Bash output.*12[,.]345 chars, 480 ms/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("health check calls the protected helper and refreshes an invalid key", async () => {
  const invocations = [];
  const response = JSON.stringify({ model: "jev-1.13.0", answers: { ready: { type: "noul", noul: 0.93 } } });
  const healthy = await checkHealth("/state", async (...args) => {
    invocations.push(args);
    return { exitCode: 0, stdout: response, stderr: "" };
  });
  assert.deepEqual(healthy, { ok: true, model: "jev-1.13.0" });
  assert.equal(invocations[0][0], "pwsh.exe");
  assert.deepEqual(invocations[0][1], ["-NoProfile", "-NonInteractive", "-File", path.join("/state", "invoke_jev.ps1")]);
  assert.equal(typeof invocations[0][2], "string");
  assert.throws(() => parseHealthOutput('{"state":"unavailable"}'));
  let calls = 0;
  const recovered = await checkHealth("/state", async () => {
    calls += 1;
    if (calls === 1) return { exitCode: 1, stdout: "", stderr: "JEV_HTTP_401" };
    if (calls === 2) return { exitCode: 0, stdout: '{"state":"ready"}', stderr: "" };
    return { exitCode: 0, stdout: response, stderr: "" };
  });
  assert.deepEqual(recovered, { ok: true, model: "jev-1.13.0" });
  assert.equal(calls, 3);
  const failed = await checkHealth("/state", async () => ({ exitCode: 1, stdout: "", stderr: "JEV_UNAVAILABLE" }));
  assert.deepEqual(failed, { ok: false, reason: "JEV_UNAVAILABLE" });
});
