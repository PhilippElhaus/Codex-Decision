"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  checkHealth, decisionSummary, outcomeLine, parseHealthOutput, readConfig,
  readEventsSince, readLatestEvent, readRecentOutcomes, writeEnabled, writeMode,
} = require("../core");

test("hook selection writes the config atomically and preserves the pilot mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    assert.deepEqual(await readConfig(directory), { enabled: false, mode: "replace" });
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

test("mode setting changes only the mode and rejects invalid values", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    await writeEnabled(directory, true);
    const observed = await writeMode(directory, "observe");
    assert.deepEqual(observed, { enabled: true, mode: "observe" });
    assert.deepEqual(await readConfig(directory), observed);
    await assert.rejects(writeMode(directory, "unknown"), /invalid Jev mode/);
    assert.deepEqual(await readConfig(directory), observed);
    assert.deepEqual(await writeMode(directory, "replace"), { enabled: true, mode: "replace" });
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
    const recent = await readRecentOutcomes(directory);
    assert.equal(recent.outcomes.length, 1);
    assert.match(outcomeLine(recent.outcomes[0]), /replaced · Bash · 12[,.]345 chars · 480 ms/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("incremental event reader keeps incomplete lines for the next poll", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    const file = path.join(directory, "events.jsonl");
    const calling = JSON.stringify({ status: "calling", reason: "jev_request", tool: "Bash" }) + "\n";
    const result = JSON.stringify({ status: "candidate", reason: "observe", tool: "Bash", original_chars: 12000, elapsed_ms: 970 }) + "\n";
    await fs.writeFile(file, calling + result.slice(0, 20));
    const first = await readEventsSince(directory, 0);
    assert.deepEqual(first.events.map((event) => event.status), ["calling"]);
    assert.equal(first.offset, Buffer.byteLength(calling));
    await fs.appendFile(file, result.slice(20));
    const second = await readEventsSince(directory, first.offset);
    assert.deepEqual(second.events.map((event) => event.status), ["candidate"]);
    assert.equal(second.offset, Buffer.byteLength(calling + result));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("recent outcomes span tools and ignore calls, skips, and malformed rows", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    const rows = [
      { status: "candidate", reason: "observe", tool: "Bash", original_chars: 9000 },
      { status: "calling", reason: "jev_request", tool: "Bash" },
      { status: "keep", reason: "jev_keep", tool: "mcp__demo__logs", original_chars: 10000 },
      { status: "skip", reason: "small", tool: "Bash", original_chars: 30 },
      { status: "replace", reason: "jev_replace", tool: "Bash", original_chars: 11000 },
      { status: "candidate", reason: "observe", tool: "mcp__demo__search", original_chars: 12000 },
    ];
    const content = rows.slice(0, 4).map((row) => JSON.stringify(row) + "\n").join("") +
      "not-json\n" + rows.slice(4).map((row) => JSON.stringify(row) + "\n").join("");
    await fs.writeFile(path.join(directory, "events.jsonl"), content);
    const recent = await readRecentOutcomes(directory);
    assert.equal(recent.offset, Buffer.byteLength(content));
    assert.deepEqual(recent.outcomes.map((row) => [row.status, row.tool]), [
      ["candidate", "mcp__demo__search"], ["replace", "Bash"], ["keep", "mcp__demo__logs"],
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("incremental reader handles log truncation and a burst larger than one read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    const file = path.join(directory, "events.jsonl");
    const line = JSON.stringify({ status: "candidate", reason: "observe", tool: "Bash", original_chars: 12000, elapsed_ms: 1000 }) + "\n";
    const count = 3200;
    await fs.writeFile(file, line.repeat(count));
    let offset = 0;
    let seen = 0;
    while (offset < Buffer.byteLength(line) * count) {
      const batch = await readEventsSince(directory, offset);
      assert.equal(batch.reset, false);
      assert.ok(batch.offset > offset);
      seen += batch.events.length;
      offset = batch.offset;
    }
    assert.equal(seen, count);
    await fs.writeFile(file, line);
    const reset = await readEventsSince(directory, offset);
    assert.deepEqual(reset, { events: [], offset: Buffer.byteLength(line), reset: true });
    await fs.appendFile(file, "invalid-json\n" + line);
    const recovered = await readEventsSince(directory, reset.offset);
    assert.deepEqual(recovered.events.map((row) => row.status), ["candidate"]);
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
