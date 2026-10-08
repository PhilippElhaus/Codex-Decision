"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  checkHealth, completeRelevancePolicy, decisionSummary, sessionDirectory, readHookHealth, estimateTokensSaved, outcomeLine, parseHealthOutput, readApiKey, readConfig,
  readEventOffset, readEventsSince, readLifetimeStats, writeApiKey, writeSelection, ensureSessionDefaults,
  readGlobalSettings, writeGlobalSettings, readInstallationStats,
  readSessionActivity, readRecentOutcomes,
} = require("../../vscode-control/core");
const withV3 = (config) => require("../../vscode-control/schema").validate("config", {
  ...config, schema_version: 4, relevance_policy: completeRelevancePolicy(),
});

test("shared CLI and control fixtures preserve exact and incomplete historical accounting", async () => {
  const cases = require("../fixtures/activity-accounting.json");
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

test("activity maps reject malformed counters and restore bounded retained history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-safe-counters-"));
  const logs = path.join(directory, "logs");
  try {
    await fs.mkdir(logs);
    const health = { version: 1, hook_version: "0.11.2", last_seen_ms: Date.now() };
    for (const skip_counts of [{ small: -1 }, { bad_reason: "1" }, { "arbitrary message": 1 }, []]) {
      await fs.writeFile(path.join(logs, "hook-health.json"), JSON.stringify({ ...health, skip_counts }));
      await assert.rejects(readSessionActivity(directory), skip_counts.small === -1 ?
        /Invalid Decision unsigned counter token/ : /Invalid Decision skip counts/);
    }
    await fs.writeFile(path.join(logs, "hook-health.json"), JSON.stringify({ ...health, errors: -1 }));
    await assert.rejects(readHookHealth(directory), /Invalid Decision unsigned counter token/);
    await fs.writeFile(path.join(logs, "hook-health.json"), JSON.stringify(health));
    await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
      calls: 2, completed: 2, replaced: 0, timed: 2, elapsedMs: 100,
      candidates: 2, candidate_observe: 1, candidate_unsupported_command: 1,
    }));
    assert.deepEqual((await readSessionActivity(directory)).candidateReasons,
      { observe: 1, unsupported_command: 1 });
    const rows = [
      { status: "replace", reason: "relevance_replace", tool: "Bash", original_chars: 1000, capsule_chars: 100 },
      { status: "classifying", reason: "classification_start", requests: 0 },
      { status: "candidate", reason: "observe", tool: "Bash", original_chars: 2000, capsule_chars: 200 },
    ];
    await fs.writeFile(path.join(logs, "events.jsonl"), "x".repeat(300_000) + "\n" +
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n" + JSON.stringify({ status: "keep", reason: "incomplete" }));
    const history = await readRecentOutcomes(directory);
    assert.deepEqual(history.map((event) => event.status), ["candidate", "replace"]);
    await assert.rejects(readRecentOutcomes(directory, 4), /Invalid Decision history limit/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("one activity snapshot uses one atomic stats record and handles short file reads", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-atomic-counters-"));
  const statsFile = path.join(directory, "stats.json");
  const eventsFile = path.join(directory, "logs", "events.jsonl");
  const originalOpen = fs.open;
  let openedStats = 0;
  let largestHistoryRead = 0;
  const first = { calls: 2, completed: 2, replaced: 0, timed: 2, elapsedMs: 100,
    candidates: 2, candidate_observe: 2, linesActuallyOmitted: 0 };
  const second = { ...first, calls: 3, completed: 3, candidates: 3, candidate_observe: 3 };
  try {
    await fs.writeFile(statsFile, JSON.stringify(first));
    await fs.mkdir(path.dirname(eventsFile));
    await fs.writeFile(eventsFile, "x".repeat(300_000) + "\n" + JSON.stringify({
      status: "replace", reason: "relevance_replace", tool: "Bash", original_chars: 1000, capsule_chars: 100,
    }) + "\n");
    fs.open = async (filename, ...args) => {
      const handle = await originalOpen(filename, ...args);
      if (filename === statsFile) {
        openedStats += 1;
        return { stat: () => handle.stat(), read: (...readArgs) => handle.read(...readArgs),
          close: async () => {
            await handle.close();
            await fs.writeFile(`${statsFile}.next`, JSON.stringify(second));
            await fs.rename(`${statsFile}.next`, statsFile);
          } };
      }
      if (filename === eventsFile) {
        return { stat: () => handle.stat(), close: () => handle.close(),
          read: (buffer, offset, length, position) => {
            largestHistoryRead = Math.max(largestHistoryRead, length);
            return handle.read(buffer, offset, Math.min(length, 1024), position);
          } };
      }
      return handle;
    };
    const snapshot = await readSessionActivity(directory);
    assert.equal(openedStats, 1, "one snapshot opens stats exactly once");
    assert.equal(snapshot.completed, 2);
    assert.equal(snapshot.candidates, 2, "related counters come from the same record despite an atomic update");
    assert.deepEqual(snapshot.candidateReasons, { observe: 2 });
    const history = await readRecentOutcomes(directory);
    assert.equal(history[0].status, "replace", "short reads continue until the bounded tail is read");
    assert.ok(largestHistoryRead <= 262_144, "history reads stay bounded despite a large event index");
  } finally {
    fs.open = originalOpen;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("activity snapshots never report fewer attempts than concurrently completed requests", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-torn-counters-"));
  const statsFile = path.join(directory, "stats.json");
  const healthFile = path.join(directory, "logs", "hook-health.json");
  const originalOpen = fs.open;
  let releaseStats;
  const healthRead = new Promise((resolve) => { releaseStats = resolve; });
  const stats = { counter_scheme: 1, calls: 2, completed: 2, replaced: 0, timed: 2, elapsedMs: 100 };
  const health = { version: 1, hook_version: "0.11.4", last_seen_ms: Date.now(), api_requests: 2,
    responses_received: 2, responses_validated: 2 };
  try {
    await fs.mkdir(path.dirname(healthFile));
    await fs.writeFile(statsFile, JSON.stringify(stats));
    await fs.writeFile(healthFile, JSON.stringify(health));
    fs.open = async (filename, ...args) => {
      if (filename === statsFile) await healthRead;
      const handle = await originalOpen(filename, ...args);
      if (filename === healthFile) {
        return { stat: () => handle.stat(), read: (...readArgs) => handle.read(...readArgs),
          close: async () => {
            await handle.close();
            // The attempt is published before completion, while this reader
            // has already captured the previous atomic health record.
            await fs.writeFile(`${healthFile}.next`, JSON.stringify({ ...health, api_requests: 3,
              responses_received: 3, responses_validated: 3 }));
            await fs.rename(`${healthFile}.next`, healthFile);
            await fs.writeFile(`${statsFile}.next`, JSON.stringify({ ...stats, calls: 3, completed: 3 }));
            await fs.rename(`${statsFile}.next`, statsFile);
            releaseStats();
          } };
      }
      return handle;
    };
    const snapshot = await readSessionActivity(directory);
    assert.equal(snapshot.hookHealth.api_requests, 2);
    assert.equal(snapshot.completed, 3);
    assert.equal(snapshot.calls, 3, "the completed request total clamps an older health read");
    assert.equal(snapshot.responsesReceived, 3);
    assert.equal(snapshot.responsesValidated, 3);
  } finally {
    releaseStats();
    fs.open = originalOpen;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a torn exact request ledger is re-read once without inventing attempts from legacy totals", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-stage-consistency-"));
  const statsFile=path.join(directory,"stats.json"),healthFile=path.join(directory,"logs/hook-health.json");
  const fixture=require("../fixtures/activity-accounting.json").find(row=>row.name==="current_exact");
  const oldHealth={...fixture.health,api_requests:6,responses_received:4,responses_validated:3,request_failures:1,request_cancelled:2};
  const newHealth={...oldHealth,api_requests:11,responses_received:9,responses_validated:8};
  const newStats={...fixture.stats,calls:8,timed:8,elapsedMs:800,completed:4};
  const originalOpen=fs.open;
  let releaseStats,healthOpens=0;
  const barrier=new Promise(resolve=>{releaseStats=resolve;});
  try {
    await fs.mkdir(path.dirname(healthFile));
    await fs.writeFile(statsFile,JSON.stringify({...fixture.stats,calls:3}));
    await fs.writeFile(healthFile,JSON.stringify(oldHealth));
    fs.open=async(filename,...args)=>{
      if(filename===statsFile) await barrier;
      const handle=await originalOpen(filename,...args);
      if(filename!==healthFile) return handle;
      const number=++healthOpens;
      return {stat:()=>handle.stat(),read:(...readArgs)=>handle.read(...readArgs),close:async()=>{
        await handle.close();
        if(number===1) {
          await fs.writeFile(`${healthFile}.next`,JSON.stringify(newHealth));await fs.rename(`${healthFile}.next`,healthFile);
          await fs.writeFile(`${statsFile}.next`,JSON.stringify(newStats));await fs.rename(`${statsFile}.next`,statsFile);
          releaseStats();
        }
      }};
    };
    const consistent=await readSessionActivity(directory);
    assert.equal(healthOpens,2,"an older health record cannot contradict disjoint terminal outcomes");
    assert.equal(consistent.calls,11);assert.equal(consistent.responsesValidated,8);
    assert.deepEqual(consistent.partialCounters,[]);
    fs.open=originalOpen;
    await fs.writeFile(healthFile,JSON.stringify(oldHealth));
    healthOpens=0;
    fs.open=async(filename,...args)=>{if(filename===healthFile) healthOpens+=1;return originalOpen(filename,...args);};
    await assert.rejects(readSessionActivity(directory),/Inconsistent Decision activity counters/);
    assert.equal(healthOpens,2,"persistent inconsistency becomes unavailable after one bounded retry");
    await fs.writeFile(healthFile,JSON.stringify({...oldHealth,hook_version:"0.11.4"}));
    healthOpens=0;
    await assert.rejects(readSessionActivity(directory),/Inconsistent Decision activity counters/);
    assert.equal(healthOpens,2,"an old writer's exact attempts still cannot lag known completions");
    const legacy={...oldHealth};delete legacy.counter_scheme;delete legacy.partial_counters;
    await fs.writeFile(healthFile,JSON.stringify(legacy));
    healthOpens=0;
    const partial=await readSessionActivity(directory);
    assert.equal(healthOpens,1);
    assert.equal(partial.calls,8,"uncertain legacy counters are not summed into invented historical attempts");
    assert.ok(partial.partialCounters.includes("calls"));
  } finally {releaseStats();fs.open=originalOpen;await fs.rm(directory,{recursive:true,force:true});}
});

test("installation totals recompute estimates and preserve exact integer limits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-total-precision-"));
  try {
    for (const session of ["one", "two", "three"]) {
      const directory = sessionDirectory(root, session);
      await ensureSessionDefaults(directory);
      await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
        counter_scheme: 1, calls: 1, completed: 1, replaced: 1, timed: 1, elapsedMs: 10,
        savedChars: 2, candidates: 0, kept: 0, linesActuallyOmitted: 1, linesRelevanceJudged: 1,
      }));
    }
    let total = await readInstallationStats(root);
    assert.equal(total.savedChars, 6);
    assert.equal(total.estimatedTokensSaved, 2, "round the combined character estimate once");
    for (const session of ["one", "two"]) {
      const directory = sessionDirectory(root, session);
      await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
        counter_scheme: 1, calls: Number.MAX_SAFE_INTEGER, completed: 1, replaced: 1,
        timed: 1, elapsedMs: Number.MAX_SAFE_INTEGER, savedChars: Number.MAX_SAFE_INTEGER,
        candidates: 0, kept: 0, linesActuallyOmitted: 1, linesRelevanceJudged: 1,
      }));
    }
    total = await readInstallationStats(root);
    for (const name of ["calls", "elapsedMs", "savedChars", "estimatedTokensSaved", "averageMs"]) {
      assert.equal(total[name], null, `${name} cannot silently return a rounded total`);
      assert.ok(total.overflowCounters.includes(name));
    }
    assert.equal(total.completed, 3, "unaffected exact counters remain available");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("aggregate reads stay bounded and await opened counter files before rejecting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-counter-workers-"));
  const originalOpen = fs.open;
  let openHandles = 0, peakHandles = 0;
  const row = require("../fixtures/activity-accounting.json").find(row => row.name === "current_exact");
  try {
    for (let index = 0; index < 20; index += 1) {
      const directory = sessionDirectory(root, `thread-${index}`);
      await fs.mkdir(path.join(directory,"logs"), {recursive:true,mode:0o700});
      await fs.writeFile(path.join(directory,"stats.json"),JSON.stringify(row.stats));
      await fs.writeFile(path.join(directory,"logs/hook-health.json"),JSON.stringify(row.health));
    }
    fs.open = async (filename,...args) => {
      const handle = await originalOpen(filename,...args);
      openHandles += 1; peakHandles = Math.max(peakHandles,openHandles);
      return {stat:()=>handle.stat(),read:(...readArgs)=>handle.read(...readArgs),close:async()=>{
        await new Promise(resolve=>setTimeout(resolve,2));
        try {await handle.close();} finally {openHandles -= 1;}
      }};
    };
    assert.equal((await readInstallationStats(root)).calls,120);
    assert.ok(peakHandles > 1 && peakHandles <= 8, `four workers open at most two metadata files each: ${peakHandles}`);
    assert.equal(openHandles,0);
    const selected = sessionDirectory(root,"thread-0");
    await fs.writeFile(path.join(selected,"logs/hook-health.json"),'{"version":"corrupt"}');
    await assert.rejects(readInstallationStats(root), /Invalid Decision hook health/);
    assert.equal(openHandles,0,"failed independent reads are joined and closed before returning");
  } finally {fs.open=originalOpen; await fs.rm(root,{recursive:true,force:true});}
});

test("global settings stay independent of session switches and aggregate activity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-global-settings-"));
  try {
    const one = sessionDirectory(root, "one");
    const two = sessionDirectory(root, "two");
    await ensureSessionDefaults(one);
    await ensureSessionDefaults(two);
    await writeSelection(one, false);
    await writeGlobalSettings(root, { mode: "observe", log_limit_mb: 72 });
    assert.equal((await readGlobalSettings(root)).mode, "observe");
    assert.equal((await readGlobalSettings(root)).log_limit_mb, 72);
    assert.equal((await readConfig(one)).enabled, false);
    assert.equal((await readConfig(two)).enabled, true);
    assert.equal((await readConfig(one)).mode, "replace");
    for (const [directory, calls, completed, elapsedMs] of [[one, 2, 2, 200], [two, 1, 1, 300]]) {
      await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
        counter_scheme: directory === one ? 1 : undefined,
        calls, completed, replaced: 1, savedChars: 40, timed: completed, elapsedMs,
      }));
    }
    const totals = await readInstallationStats(root);
    assert.equal(totals.calls, 3);
    assert.equal(totals.replaced, 2);
    assert.equal(totals.averageMs, null, "legacy timing scope cannot become a request average in installation totals");
    assert.equal(totals.timed, 3);
    assert.equal(totals.elapsedMs, 500, "raw legacy timing counters are preserved");
    await assert.rejects(writeGlobalSettings(root, { log_limit_mb: 0 }), /Invalid Decision settings/);
    assert.equal((await readGlobalSettings(root)).log_limit_mb, 72);
    await fs.rm(path.join(root, "settings.json"));
    await t.test("linked settings files are rejected", async (t) => {
      try {
        await fs.symlink(path.join(one, "config.json"), path.join(root, "settings.json"));
      } catch (error) {
        if (process.platform !== "win32" || error.code !== "EPERM") throw error;
        t.skip("Windows file symlinks require Developer Mode or elevation");
        return;
      }
      await assert.rejects(readGlobalSettings(root), /Unsafe Decision settings file/);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("new Codex sessions enable Decision once and preserve later choices", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-default-session-"));
  const first = sessionDirectory(root, "thread-one");
  const second = sessionDirectory(root, "thread-two");
  try {
    const created = await ensureSessionDefaults(first);
    assert.equal(created.enabled, true);
    await writeSelection(first, false);
    assert.equal((await ensureSessionDefaults(first)).enabled, false);
    assert.equal((await ensureSessionDefaults(second)).enabled, true);
    assert.equal((await readConfig(first)).enabled, false);
    await assert.rejects(ensureSessionDefaults(root), /session directory/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("session readers reject linked directories before opening state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-session-path-"));
  try {
    await fs.mkdir(path.join(root, "sessions"), { mode: 0o700 });
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(path.join(outside, "config.json"), JSON.stringify(withV3({
      enabled: true, mode: "replace",
    })));
    const linked = sessionDirectory(root, "linked-window");
    await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readConfig(linked), /Unsafe Decision session directory/);
    await assert.rejects(readHookHealth(linked), /Unsafe Decision session directory/);
    await assert.rejects(readLifetimeStats(linked), /Unsafe Decision session directory/);
    await assert.rejects(readEventOffset(linked), /Unsafe Decision session directory/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("global policy validates thresholds and saves independent of sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-global-policy-"));
  try {
    const session = sessionDirectory(root, "thread-one");
    await ensureSessionDefaults(session);
    const policy = completeRelevancePolicy({ relevant_max: 4 });
    await writeGlobalSettings(root, { mode: "observe", relevance_policy: policy,
      log_limit_mb: 9999, never_delete_logs: true });
    const saved = await readGlobalSettings(root);
    assert.deepEqual(saved.relevance_policy, policy);
    assert.equal(saved.never_delete_logs, true);
    assert.equal((await readConfig(session)).mode, "replace");
    for (const changes of [
      { relevance_policy: { relevant_max: 101 } },
      { relevance_policy: { typo: 80 } },
      { relevance_policy: { exact_max: 101 } },
      { log_limit_mb: 0 }, { never_delete_logs: "true" },
    ]) await assert.rejects(writeGlobalSettings(root, changes));
    assert.deepEqual(await readGlobalSettings(root), saved);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
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
    assert.equal((await readEventsSince(directory, 0)).events.at(-1).status, "replace");
    assert.equal((await readEventOffset(directory)), (await fs.stat(path.join(directory, "logs", "events.jsonl"))).size);
    assert.deepEqual(await readLifetimeStats(directory), {
      calls: 3, completed: 3, replaced: 1, savedChars: 900, estimatedTokensSaved: 225, averageMs: null, timed: 2, elapsedMs: 400,
      linesSeen: 0, linesJudged: 0, linesKept: 0, linesOmitted: 0, linesProtected: 0, linesUnjudged: 0,
      linesRelevanceJudged: 0, linesBelowOmitCutoff: 0, linesRelevanceKept: 0,
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("settings save private key and test an unsaved key without exposing it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-settings-test-"));
  try {
    await writeApiKey(directory, "saved-key-123");
    assert.equal(await readApiKey(directory), "saved-key-123");
    const result = await checkHealth(directory, async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer draft-key-456");
      return { ok: true, text: async () => JSON.stringify({ model: "gpt-6-luna", answers: [{name:"ready", type:"predicate", probability:0.9}] }) };
    }, "draft-key-456");
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes("draft-key-456"), false);
    assert.equal(await readApiKey(directory), "saved-key-123");
    await writeApiKey(directory, "updated-key-789");
    assert.equal(await readApiKey(directory), "updated-key-789");
    await assert.rejects(writeApiKey(directory, "bad key"), /invalid/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("hook selection writes the config atomically and preserves the Decision mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
  try {
    assert.deepEqual(await readConfig(directory), { enabled: false, mode: "replace" });
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(withV3({ enabled: false, mode: "replace", min_chars: 10000 })));
    assert.deepEqual(await writeSelection(directory, true), withV3({ enabled: true, mode: "replace", min_chars: 10000 }));
    assert.deepEqual(await readConfig(directory), withV3({ enabled: true, mode: "replace", min_chars: 10000 }));
    assert.equal((await writeSelection(directory, false)).enabled, false);
    await assert.rejects(writeSelection(directory, "yes"), /boolean/);
    await writeSelection(directory, false);
    assert.equal((await readConfig(directory)).enabled, false);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["config.json"]);
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
      await assert.rejects(readConfig(directory), /Invalid Decision config/);
      await assert.rejects(writeSelection(directory, true), /Invalid Decision config/);
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-hook-health-"));
  try {
    assert.equal(await readHookHealth(directory), null);
    const logs = path.join(directory, "logs");
    await fs.mkdir(logs);
    const file = path.join(logs, "hook-health.json");
    const valid = { version: 1, hook_version: "0.8.0", last_seen_ms: Date.now(), last_skip: "small", skipped: 3 };
    await fs.writeFile(file, JSON.stringify(valid));
    assert.deepEqual(await readHookHealth(directory), valid);
    await fs.writeFile(file, JSON.stringify({ ...valid, skipped: -1 }));
    await assert.rejects(readHookHealth(directory), /Invalid Decision unsigned counter token/);
    await fs.writeFile(file, JSON.stringify({ ...valid, last_error_ms: -1 }));
    await assert.rejects(readHookHealth(directory), /Invalid Decision unsigned counter token/);
    await fs.writeFile(file, JSON.stringify({ ...valid, last_seen_ms: Date.now() + 600_000 }));
    await assert.rejects(readHookHealth(directory), /Invalid Decision hook health/);
    await fs.writeFile(file, "x".repeat(5000));
    await assert.rejects(readHookHealth(directory), /Unsafe Decision hook health/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("invalid config and linked target fail without changing a hook selection", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
  try {
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ enabled: "yes" }));
    await assert.rejects(writeSelection(directory, true), /Invalid Decision config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ test_build_enabled: "yes" }));
    await assert.rejects(writeSelection(directory, false), /Invalid Decision config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ search_listing_enabled: "yes" }));
    await assert.rejects(writeSelection(directory, false), /Invalid Decision config/);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ min_chars: 1 }));
    await assert.rejects(writeSelection(directory, true), /Invalid Decision config/);
    await fs.rm(path.join(directory, "config.json"));
    try {
      await fs.symlink(path.join(directory, "missing.json"), path.join(directory, "config.json"));
      await assert.rejects(writeSelection(directory, true));
    } catch (error) {
      if (error.code !== "EPERM") throw error; // Windows developer mode may forbid test symlinks.
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("session totals scan retained decisions within one session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-lifetime-test-"));
  try {
    assert.deepEqual(await readLifetimeStats(directory), { calls: 0, completed: 0, replaced: 0,
      savedChars: 0, estimatedTokensSaved: 0, averageMs: 0, timed: 0, elapsedMs: 0,
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
      savedChars: 8000, estimatedTokensSaved: 2000, averageMs: null, timed: 4, elapsedMs: 1300,
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
  assert.equal(outcomeLine({ status: "replace", tool: "Bash", original_chars: 10000, capsule_chars: null, elapsed_ms: 100 }),
    "replaced · Bash · 10,000 chars");
  assert.equal(outcomeLine({ filter: "test_build", status: "replace", tool: "Bash", original_chars: 10000, capsule_chars: 1000, elapsed_ms: 4 }),
    "replaced · Bash · 10,000 chars · -90%");
  assert.equal(outcomeLine({ filter: "test_build", status: "replace", tool: "Bash", original_chars: 6367, capsule_chars: 309, elapsed_ms: 1263 }),
    "replaced · Bash · 6,367 chars · -95%");
  assert.equal(outcomeLine({ filter: "search_listing", status: "replace", tool: "Bash", original_chars: 5000, capsule_chars: 1200, elapsed_ms: 1263 }),
    "replaced · Bash · 5,000 chars · -76%");
  assert.match(decisionSummary({ filter: "search_listing", status: "replace", tool: "Bash", original_chars: 5000, elapsed_ms: 1263 }), /replaced Bash output/);
  assert.equal(estimateTokensSaved(6058), 1515);
  assert.equal(estimateTokensSaved(0), 0);
  assert.equal(estimateTokensSaved(NaN), 0);
});

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
