"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { sessionDirectory, readHookHealth, readLifetimeStats, ensureSessionDefaults, readInstallationStats, readSessionActivity } = require("../../../vscode-control/core");

test("shared CLI and control fixtures preserve exact and incomplete historical accounting", async () => {
  const cases = require("../../fixtures/activity-accounting.json");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-accounting-parity-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    for (const row of cases) {
      for (const [file, value] of [["stats.json", row.stats], ["logs/hook-health.json", row.health]]) {
        const target = path.join(directory, file);
        if (value === null) await fs.rm(target, { force: true });
        else await fs.writeFile(target, JSON.stringify(value));
      }
      const actual = await readSessionActivity(directory);
      for (const [key, expected] of Object.entries(row.expected)) assert.deepEqual(actual[key], expected, `${row.name}: ${key}`);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("incomplete timing totals never claim a lower-bound average",async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"decision-partial-average-"));
  try {
    const directory = sessionDirectory(root,"synthetic");
    await ensureSessionDefaults(directory);
    // One retained 1000ms request can coexist with nine missing 1ms requests:
    // 1000ms is above the true 100.9ms average, not a minimum.
    await fs.writeFile(path.join(directory,"stats.json"),JSON.stringify({counter_scheme:1,
      calls:1,completed:1,replaced:0,timed:1,elapsedMs:1000,partial_timed:1,partial_elapsedMs:1}));
    assert.equal((await readLifetimeStats(directory)).averageMs,null);
    assert.equal((await readSessionActivity(directory)).averageMs,null);
    assert.equal((await readInstallationStats(root)).averageMs,null);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test("events-only legacy sessions preserve retained lower bounds without exact zero history",async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-retained-only-"));
  try {
    await fs.mkdir(path.join(directory,"logs"));
    await fs.writeFile(path.join(directory,"logs/events.jsonl"),JSON.stringify({status:"keep",reason:"kept",
      requests:2,elapsed_ms:1000,original_chars:40,capsule_chars:40})+"\n");
    const actual = await readSessionActivity(directory);
    assert.equal(actual.calls,2);assert.equal(actual.completed,1);assert.equal(actual.seen,null);
    assert.ok(actual.partialCounters.includes("calls"));assert.equal(actual.averageMs,null);
    await fs.writeFile(path.join(directory,"logs/events.jsonl"),'{"status":"classifying","reason":"classification_start","requests":0}\n');
    const onlyStarted = await readSessionActivity(directory);
    assert.equal(onlyStarted.seen,null);assert.ok(onlyStarted.partialCounters.includes("completed"));
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});

test("corrupted legacy counter metadata cannot publish rounded overflow estimates",async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-retained-overflow-"));
  try {
    await fs.mkdir(path.join(directory,"logs"));
    const filename = path.join(directory,"logs/events.jsonl");
    const row = {status:"replace",reason:"filtered",original_chars:Number.MAX_SAFE_INTEGER,
      capsule_chars:0,requests:1,elapsed_ms:1};
    const bytes = JSON.stringify(row)+"\n"+JSON.stringify(row)+"\n";
    await fs.writeFile(filename,bytes);
    await assert.rejects(readSessionActivity(directory),/retained activity exceeds the exact numeric range/);
    assert.equal(await fs.readFile(filename,"utf8"),bytes);
    for (const original_chars of [-1,1.5,"123"]) {
      await fs.writeFile(filename,JSON.stringify({...row,original_chars})+"\n");
      const result = await readSessionActivity(directory);
      assert.equal(result.completed,0,"malformed rows supply no retained completion evidence");
      assert.equal(result.savedChars,null,"missing valid history cannot invent savings");
    }
    await fs.writeFile(filename,JSON.stringify({...row,original_chars:Number.MAX_SAFE_INTEGER+1})+"\n");
    await assert.rejects(readSessionActivity(directory),/exact numeric range/,"valid u64 outside JavaScript range is unavailable");
    await fs.writeFile(filename,JSON.stringify({...row,original_chars:10,elapsed_ms:Number.MAX_SAFE_INTEGER})+"\n"+
      JSON.stringify({...row,original_chars:10,elapsed_ms:1})+"\n");
    await assert.rejects(readLifetimeStats(directory),/exact numeric range/);
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});

test("ambiguous and incomplete exact counter snapshots are rejected", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-unique-counters-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    const healthFile = path.join(directory, "logs", "hook-health.json");
    const health = { version: 1, hook_version: "0.11.4", last_seen_ms: 1 };
    for (const duplicate of ['"seen":1,"seen":2', '"seen":1,"\\u0073een":2',
      '"skip_counts":{"small":1,"small":2}']) {
      await fs.writeFile(healthFile, `${JSON.stringify(health).slice(0,-1)},${duplicate}}`);
      await assert.rejects(readHookHealth(directory), /Duplicate Decision counter field/);
    }
    await fs.writeFile(healthFile, JSON.stringify({...health,last_error:'literal {"seen":1,"seen":2}'}));
    assert.equal((await readHookHealth(directory)).last_error, 'literal {"seen":1,"seen":2}');
    await fs.writeFile(healthFile, JSON.stringify({...health,counter_scheme:1,partial_counters:[]}));
    await assert.rejects(readHookHealth(directory), /Missing Decision activity counter/);
    await fs.rm(healthFile);
    await fs.writeFile(path.join(directory,"stats.json"), '{"calls":1,"\\u0063alls":2,"completed":0,"replaced":0,"timed":0,"elapsedMs":0}');
    await assert.rejects(readSessionActivity(directory), /Duplicate Decision counter field/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("session and installation activity count API attempts and preserve unknown legacy metrics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-session-counters-"));
  try {
    const one = sessionDirectory(root, "one");
    const two = sessionDirectory(root, "two");
    const empty = sessionDirectory(root, "empty");
    for (const directory of [one, two, empty]) await ensureSessionDefaults(directory);
    const fresh = await readSessionActivity(empty);
    assert.equal(fresh.calls, 0);
    assert.equal(fresh.seen, 0);
    assert.equal(fresh.skipped, 0);
    assert.equal(fresh.linesActuallyOmitted, 0);
    for (const [directory, calls] of [[one, 2], [two, 1]]) {
      await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
        calls, completed: 1, replaced: 1, timed: calls, elapsedMs: calls * 100, savedChars: 40,
        candidates: 0, kept: 0, linesActuallyOmitted: 4,
      }));
      await fs.mkdir(path.join(directory, "logs"), { mode: 0o700 });
      await fs.writeFile(path.join(directory, "logs", "hook-health.json"), JSON.stringify({
        version: 1, hook_version: "0.11.2", last_seen_ms: Date.now(),
        api_requests: calls + 2, seen: 12, skipped: 8, errors: 1,
        skip_counts: { small: 7, choice_kept_full_output: 1 },
        skip_details: { protected_command: 2 },
      }));
    }
    const selected = await readSessionActivity(one);
    assert.equal(selected.calls, 4);
    assert.equal(selected.skipped, 8);
    assert.equal(selected.errors, 1);
    assert.equal(selected.classificationKeptFull, 1);
    assert.equal(selected.linesActuallyOmitted, 4);
    assert.equal(selected.hookHealth.api_requests, 4);
    const totals = await readInstallationStats(root);
    assert.equal(totals.calls, 7, "pending and failed attempts count across sessions");
    assert.equal(totals.completed, 2);
    assert.equal(totals.skipped, 16);
    assert.equal(totals.errors, 2);
    assert.equal(totals.linesActuallyOmitted, 8);
    assert.deepEqual(totals.skipCounts, { small: 14, choice_kept_full_output: 2 });
    assert.deepEqual(totals.skipDetails, { protected_command: 4 });
    assert.equal(totals.averageMs, null, "unlabelled timing records cannot establish a request average");
    const legacy = sessionDirectory(root, "legacy");
    await ensureSessionDefaults(legacy);
    await fs.writeFile(path.join(legacy, "stats.json"), JSON.stringify({
      calls: 3, completed: 1, replaced: 0, timed: 3, elapsedMs: 900,
    }));
    const old = await readSessionActivity(legacy);
    assert.equal(old.calls, 3);
    assert.equal(old.skipped, null);
    assert.equal(old.errors, null);
    assert.equal(old.candidates, null);
    assert.equal(old.linesActuallyOmitted, null);
    assert.equal(old.linesRelevanceJudged, null);
    const withLegacy = await readInstallationStats(root);
    assert.equal(withLegacy.calls, 10);
    assert.equal(withLegacy.skipped, null, "unknown legacy skips do not become invented totals");
    assert.equal(withLegacy.linesActuallyOmitted, null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
