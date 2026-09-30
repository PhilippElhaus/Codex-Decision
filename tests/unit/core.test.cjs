"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  activitySummary, checkHealth, completeLinePolicy, completeSearchRelevance, DEFAULT_SEARCH_RELEVANCE, decisionSummary, sessionDirectory, readHookHealth, estimateTokensSaved, formatDuration, outcomeLine, parseHealthOutput, readApiKey, readConfig,
  readEventOffset, readEventsSince, readLatestEvent, readLifetimeStats, readRecentOutcomes, writeApiKey, writeEnabled, writeMode, writeSelection, writeSettings, writeNeverDeleteLogs,
} = require("../../vscode-control/core");
const withV2 = (config) => ({ ...config, schema_version: 2, line_policy: completeLinePolicy(),
  search_relevance: DEFAULT_SEARCH_RELEVANCE });

test("session readers reject linked directories before opening state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-session-path-"));
  try {
    await fs.mkdir(path.join(root, "sessions"), { mode: 0o700 });
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(path.join(outside, "config.json"), JSON.stringify(withV2({
      enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "replace",
    })));
    const linked = sessionDirectory(root, "linked-window");
    await fs.symlink(outside, linked);
    await assert.rejects(readConfig(linked), /Unsafe Jev session directory/);
    await assert.rejects(readHookHealth(linked), /Unsafe Jev session directory/);
    await assert.rejects(readLifetimeStats(linked), /Unsafe Jev session directory/);
    await assert.rejects(readEventOffset(linked), /Unsafe Jev session directory/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("line policy round trips and rejects invalid percentages", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-settings-test-"));
  try {
    const next = completeLinePolicy({ output: { omit_min: 96 }, search_listing: { exact_max: 4 } });
    await writeSettings(directory, "observe", next, 50, false);
    assert.equal(next.output.omit_min, 96);
    assert.equal(next.test_build.exact_max, 5);
    assert.deepEqual((await readConfig(directory)).line_policy, next);
    await assert.rejects(writeSettings(directory, "replace", { output: { omit_min: 101 } }, 50, false), /percentages/);
    await assert.rejects(writeSettings(directory, "replace", { output: { typo: 80 } }, 50, false), /Invalid Jev line policy/);
    assert.deepEqual((await readConfig(directory)).line_policy, next);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("search relevance preview and guard settings persist without changing other routes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-relevance-test-"));
  try {
    const policy = completeSearchRelevance({ guard_enabled: true, relevant_max: 7 });
    await writeSettings(directory, "replace", {}, 50, false, policy);
    assert.deepEqual((await readConfig(directory)).search_relevance, policy);
    await writeSelection(directory, false, false, true);
    assert.deepEqual((await readConfig(directory)).search_relevance, policy);
    await assert.rejects(writeSettings(directory, "replace", {}, 50, false,
      { guard_enabled: true, relevant_max: 101 }), /relevance policy/);
    assert.deepEqual((await readConfig(directory)).search_relevance, policy);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("log retention and line thresholds save atomically with strict bounds", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-retention-test-"));
  try {
    await writeSettings(directory, "observe", { output: { omit_min: 96 } }, 9999, true);
    const saved = await readConfig(directory);
    assert.equal(saved.mode, "observe");
    assert.equal(saved.line_policy.output.omit_min, 96);
    assert.equal(saved.log_limit_mb, 9999);
    assert.equal(saved.never_delete_logs, true);
    for (const invalid of [0, -1, 10000, 1.5, "50", true]) {
      await assert.rejects(writeSettings(directory, "replace", {}, invalid, false), /Log retention/);
    }
    await assert.rejects(writeSettings(directory, "replace", {}, 50, "yes"), /Log retention/);
    assert.deepEqual(await readConfig(directory), saved);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("line policy rejects unknown names and wrong types", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-methods-test-"));
  try {
    const policy = completeLinePolicy({ output: { exact_max: 3 } });
    await writeSettings(directory, "replace", policy, 50, false);
    assert.deepEqual((await readConfig(directory)).line_policy, policy);
    for (const invalid of [{ output: { score: true } }, { output: { omit_min: "95" } }, { search_listing: { exact_max: -1 } }]) {
      await assert.rejects(writeSettings(directory, "replace", invalid, 50, false), /line policy|percentages/);
    }
    assert.deepEqual((await readConfig(directory)).line_policy, policy);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("never delete can save alone without changing draft settings or needing a key", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-checkbox-test-"));
  try {
    await writeSettings(directory, "observe", { output: { omit_min: 96 } }, 75, false);
    await writeNeverDeleteLogs(directory, true);
    assert.deepEqual({ ...(await readConfig(directory)) }, {
      enabled: false, test_build_enabled: false, search_listing_enabled: false,
      mode: "observe", schema_version: 2, line_policy: completeLinePolicy({ output: { omit_min: 96 } }),
      search_relevance: DEFAULT_SEARCH_RELEVANCE, log_limit_mb: 75, never_delete_logs: true,
    });
    await assert.rejects(writeNeverDeleteLogs(directory, "true"), /boolean/);
    assert.equal((await readConfig(directory)).never_delete_logs, true);
    await writeNeverDeleteLogs(directory, false);
    assert.equal((await readConfig(directory)).never_delete_logs, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("session activity index and cumulative stats use only current paths", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-retention-test-"));
  try {
    await fs.writeFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "keep", reason: "legacy", tool: "Bash", original_chars: 1000,
    }) + "\n");
    await fs.mkdir(path.join(directory, "logs"), { recursive: true });
    await fs.writeFile(path.join(directory, "logs", "events.jsonl"), JSON.stringify({
      status: "replace", reason: "jev_replace", tool: "Bash", original_chars: 1000, capsule_chars: 100,
    }) + "\n");
    await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
      calls: 3, completed: 3, replaced: 1, savedChars: 900, timed: 2, elapsedMs: 400,
    }));
    assert.equal((await readLatestEvent(directory)).status, "replace");
    assert.equal((await readEventOffset(directory)), (await fs.stat(path.join(directory, "logs", "events.jsonl"))).size);
    assert.deepEqual(await readLifetimeStats(directory), {
      calls: 3, completed: 3, replaced: 1, savedChars: 900, estimatedTokensSaved: 225, averageMs: 200,
      linesSeen: 0, linesJudged: 0, linesKept: 0, linesOmitted: 0, linesProtected: 0, linesUnjudged: 0,
      linesRelevanceJudged: 0, linesBelowOmitCutoff: 0, linesRelevanceKept: 0,
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("settings save private key and test an unsaved key without exposing it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-settings-test-"));
  try {
    await writeApiKey(directory, "saved-key-123");
    assert.equal(await readApiKey(directory), "saved-key-123");
    const result = await checkHealth(directory, async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer draft-key-456");
      return { ok: true, text: async () => JSON.stringify({ model: "jev-1.13.0", answers: { ready: { type: "noul", noul: 0.9 } } }) };
    }, "draft-key-456");
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes("draft-key-456"), false);
    assert.equal(await readApiKey(directory), "saved-key-123");
    await writeApiKey(directory, "updated-key-789");
    assert.equal(await readApiKey(directory), "updated-key-789");
    await assert.rejects(writeApiKey(directory, "bad key"), /invalid/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("hook selection writes the config atomically and preserves the Jev mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  try {
    assert.deepEqual(await readConfig(directory), { enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace" });
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(withV2({ enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace", min_chars: 10000 })));
    assert.deepEqual(await writeEnabled(directory, true), withV2({ enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "replace", min_chars: 10000 }));
    assert.deepEqual(await readConfig(directory), withV2({ enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "replace", min_chars: 10000 }));
    assert.deepEqual(await writeSelection(directory, false, true), withV2({ enabled: false, test_build_enabled: true, search_listing_enabled: false, mode: "replace", min_chars: 10000 }));
    assert.deepEqual(await writeSelection(directory, true, true, true), withV2({ enabled: true, test_build_enabled: true, search_listing_enabled: true, mode: "replace", min_chars: 10000 }));
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
    assert.deepEqual(observed, withV2({ enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "observe" }));
    assert.deepEqual(await readConfig(directory), observed);
    await assert.rejects(writeMode(directory, "unknown"), /invalid Jev mode/);
    assert.deepEqual(await readConfig(directory), observed);
    assert.deepEqual(await writeMode(directory, "replace"), withV2({ enabled: true, test_build_enabled: false, search_listing_enabled: false, mode: "replace" }));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("outdated configuration is rejected without changing it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-current-config-"));
  try {
    for (const outdated of [
      { enabled: true, precompact_enabled: true },
      { enabled: true, sample_chars: 12000 },
      { schema_version: 1, enabled: true },
    ]) {
      const bytes = JSON.stringify(outdated);
      await fs.writeFile(path.join(directory, "config.json"), bytes);
      await assert.rejects(readConfig(directory), /Invalid Jev config/);
      await assert.rejects(writeEnabled(directory, true), /Invalid Jev config/);
      assert.equal(await fs.readFile(path.join(directory, "config.json"), "utf8"), bytes);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("session paths are stable, separate, and reject unsafe IDs", async () => {
  const root = path.join(os.tmpdir(), "jev-data");
  const first = sessionDirectory(root, "session-one");
  const second = sessionDirectory(root, "session-two");
  assert.notEqual(first, second);
  assert.equal(first, sessionDirectory(root, "session-one"));
  assert.ok(first.startsWith(path.join(root, "sessions") + path.sep));
  for (const invalid of ["", "../escape", "contains space", 5, "a".repeat(129)]) {
    assert.throws(() => sessionDirectory(root, invalid), /session ID/);
  }
});

test("hook health is private, bounded, and rejects corrupt or linked data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-hook-health-"));
  try {
    assert.equal(await readHookHealth(directory), null);
    const logs = path.join(directory, "logs");
    await fs.mkdir(logs);
    const file = path.join(logs, "hook-health.json");
    const valid = { version: 1, hook_version: "0.7.1", last_seen_ms: Date.now(), last_skip: "small" };
    await fs.writeFile(file, JSON.stringify(valid));
    assert.deepEqual(await readHookHealth(directory), valid);
    await fs.writeFile(file, JSON.stringify({ ...valid, last_error_ms: -1 }));
    await assert.rejects(readHookHealth(directory), /Invalid Jev hook health/);
    await fs.writeFile(file, JSON.stringify({ ...valid, last_seen_ms: Date.now() + 600_000 }));
    await assert.rejects(readHookHealth(directory), /Invalid Jev hook health/);
    await fs.writeFile(file, "x".repeat(5000));
    await assert.rejects(readHookHealth(directory), /Unsafe Jev hook health/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
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
    const file = path.join(directory, "logs", "events.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
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

test("session totals scan retained decisions within one session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-lifetime-test-"));
  try {
    assert.deepEqual(await readLifetimeStats(directory), { calls: 0, completed: 0, replaced: 0,
      savedChars: 0, estimatedTokensSaved: 0, averageMs: 0,
      linesSeen: 0, linesJudged: 0, linesKept: 0, linesOmitted: 0, linesProtected: 0, linesUnjudged: 0,
      linesRelevanceJudged: 0, linesBelowOmitCutoff: 0, linesRelevanceKept: 0 });
    const rows = [
      { status: "calling", reason: "jev_request" },
      { status: "replace", reason: "jev_replace", original_chars: 10000, capsule_chars: 2000, elapsed_ms: 400 },
      { status: "skip", reason: "small", original_chars: 10, elapsed_ms: 0 },
      { status: "calling", reason: "jev_request" },
      { status: "candidate", reason: "observe", original_chars: 12000, capsule_chars: 0, elapsed_ms: 600 },
      { status: "keep", reason: "jev_keep", original_chars: 8000, elapsed_ms: 200 },
      { status: "replace", reason: "jev_replace", original_chars: 9000, capsule_chars: null, elapsed_ms: 100 },
    ];
    await fs.mkdir(path.join(directory, "logs"), { recursive: true });
    await fs.writeFile(path.join(directory, "logs", "events.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\nnot-json\n");
    assert.deepEqual(await readLifetimeStats(directory), { calls: 2, completed: 4, replaced: 2,
      savedChars: 8000, estimatedTokensSaved: 2000, averageMs: 325,
      linesSeen: 0, linesJudged: 0, linesKept: 0, linesOmitted: 0, linesProtected: 0, linesUnjudged: 0,
      linesRelevanceJudged: 0, linesBelowOmitCutoff: 0, linesRelevanceKept: 0 });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Monitor stats with no savedChars read as zero for existing sessions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-monitor-stats-"));
  try {
    await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
      calls: 2, completed: 1, replaced: 0, timed: 2, elapsedMs: 948,
      linesSeen: 58, linesJudged: 55,
    }));
    const stats = await readLifetimeStats(directory);
    assert.equal(stats.savedChars, 0);
    assert.equal(stats.estimatedTokensSaved, 0);
    assert.equal(stats.linesJudged, 55);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
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
    await fs.mkdir(path.join(directory, "logs"), { recursive: true });
    await fs.writeFile(path.join(directory, "logs", "events.jsonl"), content);
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
    assert.deepEqual(await checkHealth(directory, async () => ({ ok: false, status: 401,
      text: async () => '{"error":{"code":"expired_api_key"}}' })),
    { ok: false, reason: "JEV_KEY_EXPIRED" });
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
