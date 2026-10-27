"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../vscode-control/core");
const { readPanelActivity } = require("../../vscode-control/panel-state");
const { createActivityReader } = require("../../vscode-control/activity-cache");
const publication = require("../fixtures/publication-case.json");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-activity-cache-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "logs"), { mode: 0o700 });
  const write = (name, value) => fs.writeFile(path.join(directory, name),
    typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  const stats = { calls: 2, completed: 1, replaced: 0, timed: 2, elapsedMs: 10,
    candidates: 1, candidate_observe: 1 };
  const health = { version: 1, hook_version: "0.11.2", last_seen_ms: 1,
    api_requests: 3, skip_counts: { small: 2 } };
  await write("stats.json", stats); await write("logs/hook-health.json", health);
  return { directory, write, stats, health };
}

test("composer and panel share concurrent and unchanged activity file reads", async t => {
  const { directory } = await fixture(t), filename = path.join(directory, "stats.json");
  const open = fs.open;
  let reads = 0;
  fs.open = async function (target, ...args) {
    if (target === filename) reads += 1;
    return open.call(this, target, ...args);
  };
  try {
    const [composer, panel] = await Promise.all([core.readSessionActivity(directory), readPanelActivity(directory)]);
    assert.equal(composer.calls, 3); assert.equal(panel.calls, 3);
    assert.equal(reads, 1);
    await core.readSessionActivity(directory); await readPanelActivity(directory);
    assert.equal(reads, 1, "unchanged polling reuses parsed activity");
  } finally { fs.open = open; }
});

test("ledger updates without events and same-content atomic replacements invalidate activity", async t => {
  const { directory, write, stats, health } = await fixture(t);
  const filename = path.join(directory, "stats.json"), open = fs.open;
  let reads = 0;
  fs.open = async function (target, ...args) {
    if (target === filename) reads += 1;
    return open.call(this, target, ...args);
  };
  try {
    assert.equal((await core.readSessionActivity(directory)).calls, 3);
    await write("stats.json", { ...stats, calls: 4 });
    assert.equal((await core.readSessionActivity(directory)).calls, 4);
    await write("logs/hook-health.json", { ...health, api_requests: 9 });
    assert.equal((await core.readSessionActivity(directory)).calls, 9);
    await write("stats.next", { ...stats, calls: 4 });
    await fs.rename(path.join(directory, "stats.next"), filename);
    assert.equal((await core.readSessionActivity(directory)).calls, 9);
    assert.equal(reads, 4);
  } finally { fs.open = open; }
});

test("cached nested activity stays isolated from callers and installation aggregation", async t => {
  const { directory } = await fixture(t);
  const first = await core.readSessionActivity(directory);
  first.skipCounts.small = 999; first.hookHealth.skip_counts.small = 998;
  first.candidateReasons.observe = 997; first.partialCounters.push("changed");
  const second = await core.readSessionActivity(directory);
  assert.equal(second.skipCounts.small, 2); assert.equal(second.hookHealth.skip_counts.small, 2);
  assert.equal(second.candidateReasons.observe, 1); assert.equal(second.partialCounters.includes("changed"), false);
  const session = core.sessionDirectory(directory, "synthetic");
  await core.ensureSessionDefaults(session);
  await fs.mkdir(path.join(session, "logs"), { mode: 0o700 });
  await fs.writeFile(path.join(session, "logs/hook-health.json"), JSON.stringify({
    version: 1, hook_version: "0.11.2", last_seen_ms: 1, skip_counts: { small: 4 } }));
  assert.equal((await core.readInstallationStats(directory)).skipCounts.small, 6);
  assert.equal((await core.readSessionActivity(directory)).skipCounts.small, 2);
});

test("events-only legacy activity invalidates when the retained log changes", async t => {
  const { directory, write } = await fixture(t);
  await fs.rm(path.join(directory, "stats.json")); await fs.rm(path.join(directory, "logs/hook-health.json"));
  const event = calls => JSON.stringify({ status: "keep", reason: "no_omissions", requests: calls,
    elapsed_ms: 10, original_chars: 1000, capsule_chars: 1000 }) + "\n";
  await write("logs/events.jsonl", event(1));
  assert.equal((await core.readSessionActivity(directory)).calls, 1);
  await write("logs/events.jsonl", event(3));
  assert.equal((await core.readSessionActivity(directory)).calls, 3);
});

test("active publications bypass cached values and keep strict image validation", async t => {
  const { directory, write } = await fixture(t);
  await fs.rm(path.join(directory, "logs/hook-health.json"));
  await write("stats.json", publication.stats_after);
  await write("logs/events.jsonl", publication.events_before + publication.event);
  assert.equal((await core.readSessionActivity(directory)).completed, 2);
  await write("logs/.decision-publication.json", publication.prepared);
  assert.equal((await core.readSessionActivity(directory)).completed, 1);
  assert.equal((await core.readSessionActivity(directory)).completed, 1);
  await write("logs/.decision-publication.json", { ...publication.prepared, state: "committed" });
  assert.equal((await core.readSessionActivity(directory)).completed, 2);
  await write("stats.json", { calls: 999 });
  await assert.rejects(core.readSessionActivity(directory), /image changed/);
});

test("failed reads are evicted and unstable captured snapshots are not cached", async t => {
  const { directory, write, stats } = await fixture(t);
  let reads = 0;
  const read = createActivityReader(async () => {
    reads += 1;
    if (reads === 1) throw new Error("synthetic read failure");
    if (reads === 2) await write("stats.json", { ...stats, calls: 4 });
    return { reads };
  });
  await assert.rejects(read(directory), /synthetic read failure/);
  assert.equal((await read(directory)).reads, 2);
  assert.equal((await read(directory)).reads, 3);
  assert.equal((await read(directory)).reads, 3);
});

test("a journal change during a read retries before promoting the captured value", async t => {
  const { directory, write } = await fixture(t);
  await write("logs/events.jsonl", publication.events_before + publication.event);
  let reads = 0;
  const read = createActivityReader(async () => {
    reads += 1;
    if (reads === 1) await write("logs/.decision-publication.json", publication.prepared);
    return { reads };
  });
  assert.equal((await read(directory)).reads, 2);
  await fs.rm(path.join(directory, "logs/.decision-publication.json"));
  assert.equal((await read(directory)).reads, 3);
  assert.equal((await read(directory)).reads, 3);
});

test("a transient journal cannot cache a prior image under unchanged staged ledgers", async t => {
  const { directory, write } = await fixture(t);
  await write("logs/events.jsonl", publication.events_before + publication.event);
  let reads = 0;
  const read = createActivityReader(async () => {
    reads += 1;
    if (reads === 1) {
      await write("logs/.decision-publication.json", publication.prepared);
      await fs.rm(path.join(directory, "logs/.decision-publication.json"));
      return { completed: 1 };
    }
    return { completed: 2 };
  });
  assert.equal((await read(directory)).completed, 1, "the captured prior image remains a valid result");
  assert.equal((await read(directory)).completed, 2, "the transient journal prevents stale promotion");
  assert.equal((await read(directory)).completed, 2);
  assert.equal(reads, 2);
});

test("the activity cache evicts older directories at its fixed capacity", async t => {
  const { directory } = await fixture(t);
  let reads = 0;
  const read = createActivityReader(async () => ({ reads: ++reads }), 2);
  const directories = [];
  for (let i = 0; i < 3; i += 1) {
    const scope = path.join(directory, String(i));
    await fs.mkdir(scope, { mode: 0o700 }); directories.push(scope);
    await read(scope);
  }
  assert.equal((await read(directories[2])).reads, 3);
  assert.equal((await read(directories[0])).reads, 4);
});

test("cached activity cannot hide a linked or oversized ledger", { skip: process.platform === "win32" }, async t => {
  const { directory, write } = await fixture(t);
  await core.readSessionActivity(directory);
  const filename = path.join(directory, "stats.json");
  await write("outside.json", { calls: 999 });
  await fs.rm(filename); await fs.symlink(path.join(directory, "outside.json"), filename);
  await assert.rejects(core.readSessionActivity(directory), /Unsafe/);
  await fs.rm(filename); await write("stats.json", " ".repeat(8193));
  await assert.rejects(core.readSessionActivity(directory), /Unsafe/);
});
