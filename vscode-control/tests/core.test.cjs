"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  activitySummary, checkHealth, decisionSummary, estimateTokensSaved, formatDuration, outcomeLine, parseHealthOutput, readApiKey, readConfig,
  readEventOffset, readEventsSince, readLatestEvent, readRecentOutcomes, writeEnabled, writeMode, writeSelection,
} = require("../core");

test("hook selection writes the config atomically and preserves the Jev mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    assert.deepEqual(await readConfig(directory), { enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace" });
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ mode: "replace", min_chars: 10000 }));
    assert.deepEqual(await writeEnabled(directory, true), { enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "replace", min_chars: 10000 });
    assert.deepEqual(await readConfig(directory), { enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "replace", min_chars: 10000 });
    assert.deepEqual(await writeSelection(directory, false, true), { enabled: false, test_build_enabled: true, search_listing_enabled: false, mode: "replace", min_chars: 10000 });
    assert.deepEqual(await writeSelection(directory, true, true, true), { enabled: true, test_build_enabled: true, search_listing_enabled: true, mode: "replace", min_chars: 10000 });
    assert.equal((await writeSelection(directory, false, false)).search_listing_enabled, true);
    await assert.rejects(writeSelection(directory, true, "yes"), /booleans/);
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
    assert.deepEqual(observed, { enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "observe" });
    assert.deepEqual(await readConfig(directory), observed);
    await assert.rejects(writeMode(directory, "unknown"), /invalid Jev mode/);
    assert.deepEqual(await readConfig(directory), observed);
    assert.deepEqual(await writeMode(directory, "replace"), { enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "replace" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("legacy PreCompact selection is retired without enabling search/listing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ enabled: true, precompact_enabled: true }));
    const config = await readConfig(directory);
    assert.equal(config.enabled, true);
    assert.equal(config.search_listing_enabled, false);
    assert.equal(Object.hasOwn(config, "precompact_enabled"), false);
    await writeSelection(directory, true, true, true);
    assert.equal((await fs.readFile(path.join(directory, "config.json"), "utf8")).includes("precompact"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("invalid config and linked target fail without changing a hook selection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ enabled: "yes" }));
    await assert.rejects(writeEnabled(directory, true), /Invalid Jev config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ test_build_enabled: "yes" }));
    await assert.rejects(writeSelection(directory, false, true), /Invalid Jev config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ search_listing_enabled: "yes" }));
    await assert.rejects(writeSelection(directory, false, false, true), /Invalid Jev config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ min_chars: 1 }));
    await assert.rejects(writeEnabled(directory, true), /Invalid Jev config/);
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
      JSON.stringify({ tool: "Bash", status: "replace", reason: "jev_replace", original_chars: 12345, capsule_chars: 1000, elapsed_ms: 480 }) + "\n" +
      JSON.stringify({ tool: "Bash", status: "skip", reason: "small", original_chars: 42, elapsed_ms: 0 }) + "\n");
    const event = await readLatestEvent(directory);
    assert.equal(event.reason, "small");
    const decision = await readLatestEvent(directory, { informativeOnly: true });
    assert.equal(decision.status, "replace");
    assert.match(decisionSummary(decision), /replaced Bash output.*12[,.]345 chars$/);
    const recent = await readRecentOutcomes(directory);
    assert.equal(recent.outcomes.length, 1);
    assert.match(outcomeLine(recent.outcomes[0]), /replaced · Bash · 12[,.]345 chars · -92%/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("summary keeps three signals and missing capsule sizes do not imply savings", () => {
  assert.equal(activitySummary({ calls: 1, replaced: 1, completed: 1, elapsedMs: 1328 }),
    "1 checked · 1 replaced · 1,3s avg");
  assert.equal(activitySummary({ calls: 0, replaced: 0, completed: 0, elapsedMs: 0 }),
    "0 checked · 0 replaced · — avg");
  assert.equal(outcomeLine({ status: "replace", tool: "Bash", original_chars: 10000, capsule_chars: null, elapsed_ms: 100 }),
    "replaced · Bash · 10,000 chars");
  assert.equal(outcomeLine({ filter: "test_build", status: "replace", tool: "Bash", original_chars: 10000, capsule_chars: 1000, elapsed_ms: 4 }),
    "replaced · test/build · 10,000 chars · -90%");
  assert.equal(outcomeLine({ filter: "test_build", status: "replace", tool: "Bash", original_chars: 6367, capsule_chars: 309, elapsed_ms: 1263 }),
    "replaced · test/build · 6,367 chars · -95%");
  assert.equal(activitySummary({ completed: 1, replaced: 1, elapsedMs: 1263 }),
    "1 checked · 1 replaced · 1,2s avg");
  assert.equal(formatDuration(999), "999 ms");
  assert.equal(formatDuration(1000), "1,0s");
  assert.equal(outcomeLine({ filter: "search_listing", status: "replace", tool: "Bash", original_chars: 5000, capsule_chars: 1200, elapsed_ms: 1263 }),
    "replaced · search/listing · 5,000 chars · -76%");
  assert.match(decisionSummary({ filter: "search_listing", status: "replace", tool: "Bash", original_chars: 5000, elapsed_ms: 1263 }), /replaced search\/listing Bash output/);
  assert.equal(estimateTokensSaved(6058), 1515);
  assert.equal(estimateTokensSaved(0), 0);
  assert.equal(estimateTokensSaved(NaN), 0);
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

test("new controls start after existing log entries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    assert.equal(await readEventOffset(directory), 0);
    const file = path.join(directory, "events.jsonl");
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

test("health check reads the private .env and keeps the key out of status", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-health-test-"));
  const response = JSON.stringify({ model: "jev-1.13.0", answers: { ready: { type: "noul", noul: 0.93 } } });
  try {
    assert.deepEqual(await checkHealth(directory, async () => { throw new Error("must not call"); }),
      { ok: false, reason: "JEV_KEY_MISSING" });
    await fs.writeFile(path.join(directory, ".env"), "JEV_API_KEY=test-key-only\n", { mode: 0o600 });
    assert.equal(await readApiKey(directory), "test-key-only");
    const healthy = await checkHealth(directory, async (url, options) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(options.headers.Authorization, "Bearer test-key-only");
      assert.equal(JSON.parse(options.body).questions.ready.type, "noul");
      return { ok: true, text: async () => response };
    });
    assert.deepEqual(healthy, { ok: true, model: "jev-1.13.0" });
    assert.equal(JSON.stringify(healthy).includes("test-key-only"), false);
    assert.throws(() => parseHealthOutput('{"state":"unavailable"}'));
    assert.deepEqual(await checkHealth(directory, async () => ({ ok: false, status: 401 })),
      { ok: false, reason: "JEV_HTTP_401" });
    assert.deepEqual(await checkHealth(directory, async () => { throw new Error("network"); }),
      { ok: false, reason: "JEV_NETWORK_ERROR" });
    assert.deepEqual(await checkHealth(directory, async () => { throw new DOMException("timed out", "TimeoutError"); }),
      { ok: false, reason: "JEV_TIMEOUT" });
    assert.deepEqual(await checkHealth(directory, async () => ({ ok: true, text: async () => "not json" })),
      { ok: false, reason: "JEV_INVALID_RESPONSE" });
    await fs.writeFile(path.join(directory, ".env"), "JEV_API_KEY=short\n");
    assert.deepEqual(await checkHealth(directory, async () => { throw new Error("must not call"); }),
      { ok: false, reason: "JEV_KEY_MISSING" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
