"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkHealth, parseHealthOutput, readApiKey, readEventOffset, readEventsSince, readLifetimeStats } = require("../../../vscode-control/core");

test("incremental event reader keeps incomplete lines for the next poll", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    const file = path.join(directory, "logs", "events.jsonl");
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

test("new controls start after existing log entries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    assert.equal(await readEventOffset(directory), 0);
    const file = path.join(directory, "logs", "events.jsonl");
    const historical = JSON.stringify({ status: "keep", reason: "jev_keep", tool: "Bash", original_chars: 13006 }) + "\n";
    await fs.writeFile(file, historical);
    const offset = await readEventOffset(directory);
    assert.equal(offset, Buffer.byteLength(historical));
    assert.deepEqual(await readEventsSince(directory, offset), { events: [], offset, reset: false });
    await fs.appendFile(file, JSON.stringify({ status: "replace", reason: "jev_replace", tool: "Bash", original_chars: 12000 }) + "\n");
    assert.deepEqual((await readEventsSince(directory, offset)).events.map((event) => event.status), ["replace"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("recent outcomes span tools and ignore calls, skips, and malformed rows", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
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
    await fs.mkdir(path.join(directory, "logs"), { recursive: true });
    await fs.writeFile(path.join(directory, "logs", "events.jsonl"), content);
    const recent = await readEventsSince(directory, 0);
    assert.equal(recent.offset, Buffer.byteLength(content));
    assert.equal(recent.events.length, 6);
    assert.equal(recent.events.at(-1).tool, "mcp__demo__search");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("incremental reader handles log truncation and a burst larger than one read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    const file = path.join(directory, "logs", "events.jsonl");
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

test("health check reads the private .env and keeps the key out of status", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-health-test-"));
  const response = JSON.stringify({ model: "gpt-6-luna", answers: [{name:"ready", type:"predicate", probability:0.93}] });
  try {
    assert.deepEqual(await checkHealth(directory, async () => { throw new Error("must not call"); }),
      { ok: false, reason: "DECISION_KEY_MISSING" });
    await fs.writeFile(path.join(directory, ".env"), "OPENAI_API_KEY=test-key-only\n", { mode: 0o600 });
    assert.equal(await readApiKey(directory), "test-key-only");
    const healthy = await checkHealth(directory, async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/decisions");
      assert.equal(options.headers.Authorization, "Bearer test-key-only");
      assert.equal(JSON.parse(options.body).questions[0].type, "predicate");
      assert.equal(options.redirect, "error");
      return { ok: true, text: async () => response };
    });
    assert.deepEqual(healthy, { ok: true, model: "gpt-6-luna" });
    assert.equal(JSON.stringify(healthy).includes("test-key-only"), false);
    assert.throws(() => parseHealthOutput('{"state":"unavailable"}'));
    assert.deepEqual(await checkHealth(directory, async () => ({ ok: false, status: 401 })),
      { ok: false, reason: "DECISION_HTTP_401" });
    assert.deepEqual(await checkHealth(directory, async () => ({ ok: false, status: 401,
      text: async () => '{"error":{"code":"expired_api_key"}}' })),
    { ok: false, reason: "DECISION_KEY_EXPIRED" });
    assert.deepEqual(await checkHealth(directory, async () => { throw new Error("network"); }),
      { ok: false, reason: "DECISION_NETWORK_ERROR" });
    assert.deepEqual(await checkHealth(directory, async () => { throw new DOMException("timed out", "TimeoutError"); }),
      { ok: false, reason: "DECISION_TIMEOUT" });
    assert.deepEqual(await checkHealth(directory, async () => ({ ok: true, text: async () => "not json" })),
      { ok: false, reason: "DECISION_INVALID_RESPONSE" });
    await fs.writeFile(path.join(directory, ".env"), "JEV_API_KEY=short\n");
    assert.deepEqual(await checkHealth(directory, async () => { throw new Error("must not call"); }),
      { ok: false, reason: "DECISION_KEY_MISSING" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("classification activity is free of line outcomes and preserves large batch call totals", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-stage-events-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    await fs.writeFile(path.join(directory, "logs/events.jsonl"), [
      { status: "classifying", reason: "classification_start", requests: 0 },
      { status: "replace", reason: "jev_replace", requests: 85, original_chars: 50000, capsule_chars: 1000 },
    ].map(event => JSON.stringify(event)).join("\n") + "\n");
    const batch = await readEventsSince(directory, 0);
    assert.equal(batch.events[0].status, "classifying");
    assert.equal(batch.events[1].requests, 85);
    const totals = await readLifetimeStats(directory);
    assert.equal(totals.calls, 85);
    assert.equal(totals.completed, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
