"use strict";

// Frozen JavaScript reader for comparing the native view with older releases.
// The integrated VSIX ships only the native accounting reader.
const fs = require("node:fs/promises");
const path = require("node:path");
const { constants } = require("node:fs");
const { validateStatsRecord, STATS_ACTIVITY_KEYS, readFileRecord, parseUnsignedJson } = require("./private-records");
const { readPublishedRecord, withPublication } = require("./publication-journal");
const LEGACY_PARTIAL_STATS = ["candidates", "kept", "linesActuallyOmitted", "linesRelevanceJudged"];
const REQUEST_OUTCOME_KEYS = ["request_cancelled", "responses_received", "responses_validated", "request_failures"];

module.exports = function activityReference({ readSessionActivity, readHookHealth, readFileRange,
  validateCounterMap, activityLogPath, isDecisionOutcome, savedCharacters, estimateTokensSaved, HEALTH_ACTIVITY_KEYS }) {
  async function readInstallationStats(directory) {
    const { hookHealth: _health, ...totals } = await readSessionActivity(directory);
    let entries;
    try {
      const parent = await fs.lstat(path.join(directory, "sessions"));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe Decision sessions directory");
      entries = await fs.readdir(path.join(directory, "sessions"), { withFileTypes: true });
    }
    catch (error) {
      if (error.code === "ENOENT") return totals;
      throw error;
    }
    if (entries.length > 10_000) throw new Error("Too many Decision sessions");
    let cursor = 0;
    const add = (previous, amount, name) => {
      if (previous === null || amount === null) return null;
      const value = previous + amount;
      if (Number.isSafeInteger(value)) return value;
      if (!totals.overflowCounters.includes(name)) totals.overflowCounters.push(name);
      return null;
    };
    // Bound both concurrent file descriptors and outstanding filesystem work.
    // One slow session does not serialize every remaining installation read.
    const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe Decision session directory");
        const stats = await readSessionActivity(path.join(directory, "sessions", entry.name));
        for (const key of Object.keys(totals)) {
          if (["averageMs", "estimatedTokensSaved"].includes(key)) continue;
          if (["partialCounters", "overflowCounters"].includes(key)) totals[key] = [...new Set([...totals[key], ...stats[key]])].sort();
          else if (["skipReasonsPartial", "skipDetailsPartial"].includes(key)) totals[key] ||= stats[key];
          else if (["skipCounts", "skipDetails", "candidateReasons"].includes(key)) {
            for (const [reason, count] of Object.entries(stats[key])) {
              const previous = Object.hasOwn(totals[key], reason) ? totals[key][reason] : 0;
              totals[key][reason] = add(previous, count, `${key}.${reason}`);
            }
          } else totals[key] = add(totals[key], stats[key], key);
        }
      }
    });
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    totals.averageMs = totals.elapsedMs === null || totals.timed === null ||
      ["averageMs","elapsedMs","timed"].some(name=>totals.partialCounters.includes(name)) ? null :
      roundedAverage(totals.elapsedMs, totals.timed);
    totals.estimatedTokensSaved = totals.savedChars === null ? null : estimateTokensSaved(totals.savedChars);
    if (totals.overflowCounters.includes("savedChars")) totals.overflowCounters.push("estimatedTokensSaved");
    if (totals.overflowCounters.includes("elapsedMs") || totals.overflowCounters.includes("timed")) totals.overflowCounters.push("averageMs");
    totals.overflowCounters = [...new Set(totals.overflowCounters)].sort();
    return totals;
  }

  // Request attempts and completion totals have different commit points. The
  // hook health counter includes pending and failed API requests; completion
  // stats contain only results that published all required artifacts.
  async function readSessionActivityUncached(directory) {
    const reads = await Promise.allSettled([
      readRecordedStats(directory), readHookHealth(directory),
    ]);
    const failed = reads.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const recorded = reads[0].value;
    let hookHealth = reads[1].value;
    const totals = await lifetimeStats(directory, recorded);
    // Python-era calls counted pre-transport intents. A migrated or unlabelled
    // ledger cannot prove that those attempts received valid answers.
    const completedCalls = statsBaselineIsFresh(recorded) ? totals.calls : 0;
    if (activityCountersConflict(totals.calls, hookHealth, completedCalls)) {
      hookHealth = await readHookHealth(directory);
      if (activityCountersConflict(totals.calls, hookHealth, completedCalls)) throw new Error("Inconsistent Decision activity counters");
    }
    const hasActivity = hookHealth !== null || recorded !== null || totals.retainedActivity || totals.calls > 0 || totals.completed > 0;
    const unknown = hasActivity ? null : 0;
    const candidateReasons = Object.fromEntries(Object.entries(recorded || {})
      .filter(([key]) => key.startsWith("candidate_")).map(([key, count]) => [key.slice(10), count]));
    validateCounterMap(candidateReasons, "candidate reasons");
    const partial = new Set();
    if (hookHealth) {
      const terminal = hookHealth.responses_validated + hookHealth.request_failures + hookHealth.request_cancelled;
      const pendingOutcomes = !Number.isSafeInteger(hookHealth.api_requests) ||
        !Number.isSafeInteger(terminal) || terminal < hookHealth.api_requests;
      for (const [key, metric] of Object.entries(HEALTH_ACTIVITY_KEYS)) {
        if (hookHealth.counter_scheme !== 1 || hookHealth.partial_counters?.includes(key) ||
            REQUEST_OUTCOME_KEYS.includes(key) && (!requestOutcomesCovered(hookHealth) || pendingOutcomes)) partial.add(metric);
      }
    } else if (hasActivity) partial.add("calls");
    if (recorded) {
      for (const metric of STATS_ACTIVITY_KEYS) {
        if (metric === "calls" && hookHealth?.counter_scheme === 1 && hookHealth.api_requests !== undefined &&
            !hookHealth.partial_counters.includes("api_requests")) continue;
        if (recorded[`partial_${metric}`] === 1 || recorded.counter_scheme !== 1 &&
            (LEGACY_PARTIAL_STATS.includes(metric) || recorded[metric] === undefined)) partial.add(metric);
      }
    } else if (hasActivity) for (const metric of STATS_ACTIVITY_KEYS) {
      if (metric === "calls" && hookHealth?.counter_scheme === 1 && hookHealth.api_requests !== undefined &&
          !hookHealth.partial_counters.includes("api_requests")) continue;
      partial.add(metric);
    }
    const skipReasonsPartial = hookHealth?.skip_reasons_partial ?? (hookHealth !== null);
    const skipDetailsPartial = hookHealth?.skip_details_partial ?? (hookHealth !== null);
    const noRecordedReplacement = recorded?.replaced === 0 && recorded.partial_replaced !== 1;
    const savedChars = recorded?.savedChars ?? (noRecordedReplacement ? 0 :
      recorded === null && totals.completed > 0 ? totals.savedChars : unknown);
    if (noRecordedReplacement && recorded.savedChars === undefined) partial.delete("savedChars");
    if (skipReasonsPartial) partial.add("classificationKeptFull");
    if (partial.has("savedChars")) partial.add("estimatedTokensSaved");
    if (partial.has("elapsedMs") || partial.has("timed")) partial.add("averageMs");
    if (recorded && !statsBaselineIsFresh(recorded)) partial.add("averageMs");
    // Health increments precede completion publication, but these two atomic
    // files can be read on opposite sides of a concurrent completion. Completed
    // requests remain a valid lower bound when the opened health record is older.
    const lineMetrics = Object.fromEntries(STATS_ACTIVITY_KEYS.filter((key) => key.startsWith("lines"))
      .map((key) => [key, recorded?.[key] ?? unknown]));
    return { ...totals, ...lineMetrics, savedChars,
      averageMs: partial.has("averageMs") ? null : totals.averageMs,
      estimatedTokensSaved: savedChars === null ? null : estimateTokensSaved(savedChars),
      calls: Math.max(hookHealth?.api_requests ?? totals.calls, totals.calls),
      linesRelevanceJudged: recorded?.linesRelevanceJudged ?? unknown,
      seen: hookHealth?.seen ?? unknown, skipped: hookHealth?.skipped ?? unknown,
      errors: hookHealth?.errors ?? unknown, candidates: recorded?.candidates ?? unknown,
      requestCancelled: hookHealth?.request_cancelled ?? unknown,
      responsesReceived: hookHealth?.responses_received === undefined ? unknown : Math.max(hookHealth.responses_received, completedCalls),
      responsesValidated: hookHealth?.responses_validated === undefined ? unknown : Math.max(hookHealth.responses_validated, completedCalls),
      requestFailures: hookHealth?.request_failures ?? unknown,
      kept: recorded?.kept ?? unknown, linesActuallyOmitted: recorded?.linesActuallyOmitted ?? unknown,
      classificationKeptFull: hookHealth?.skip_counts ? hookHealth.skip_counts.choice_kept_full_output ?? 0 : unknown,
      skipCounts: { ...hookHealth?.skip_counts }, skipDetails: { ...hookHealth?.skip_details }, candidateReasons,
      partialCounters: [...partial].sort(), overflowCounters: [], skipReasonsPartial, skipDetailsPartial, hookHealth };
  }

  function activityCountersConflict(recordedCalls, health, completedCalls) {
    if (health?.counter_scheme === 1 && !health.partial_counters.includes("api_requests") &&
        health.api_requests !== undefined && health.api_requests < recordedCalls) return true;
    const fields = ["api_requests", "responses_received", "responses_validated", "request_failures", "request_cancelled"];
    if (health?.counter_scheme !== 1 || !requestOutcomesCovered(health) || fields.some((name) => health[name] === undefined || health.partial_counters.includes(name))) return false;
    const attempts = Math.max(health.api_requests, recordedCalls);
    const received = Math.max(health.responses_received, completedCalls);
    const validated = Math.max(health.responses_validated, completedCalls);
    const terminal = validated + health.request_failures + health.request_cancelled;
    return validated > received || received > attempts - health.request_cancelled ||
      !Number.isSafeInteger(terminal) || terminal > attempts;
  }

  function requestOutcomesCovered(health) {
    const parts = health?.hook_version?.split(".").map(Number);
    return parts?.length === 3 && parts.every(Number.isSafeInteger) &&
      (parts[0] > 0 || parts[0] === 0 && (parts[1] > 11 || parts[1] === 11 && parts[2] >= 5));
  }

  async function readRecordedStats(directory) {
    const record = await readPublishedRecord(directory,"stats",options =>
      readFileRecord(path.join(directory,"stats.json"),8192,options));
    return record ? validateStatsRecord(parseUnsignedJson(record.bytes,keys => keys.length === 1)) : null;
  }

  async function readLifetimeStats(directory) {
    return lifetimeStats(directory, await readRecordedStats(directory));
  }

  async function lifetimeStats(directory, stats) {
    const totals = { calls: 0, completed: 0, replaced: 0, savedChars: 0,
      estimatedTokensSaved: 0, averageMs: 0, timed: 0, elapsedMs: 0, linesSeen: 0, linesJudged: 0,
      linesKept: 0, linesOmitted: 0, linesProtected: 0, linesUnjudged: 0,
      linesRelevanceJudged: 0, linesBelowOmitCutoff: 0, linesRelevanceKept: 0 };
    if (stats !== null) {
      for (const key of ["calls", "completed", "replaced", "timed", "elapsedMs"]) {
        if (!Number.isSafeInteger(stats[key]) || stats[key] < 0) throw new Error("Invalid Decision stats file");
      }
      const savedChars = stats.savedChars ?? 0;
      if (!Number.isSafeInteger(savedChars) || savedChars < 0) throw new Error("Invalid Decision stats file");
      const lineStats = Object.fromEntries(["linesSeen", "linesJudged", "linesKept", "linesOmitted",
        "linesProtected", "linesUnjudged", "linesRelevanceJudged", "linesBelowOmitCutoff", "linesRelevanceKept"].map((key) => {
        const value = stats[key] ?? 0;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Decision line stats");
        return [key, value];
      }));
      return { calls: stats.calls, completed: stats.completed, replaced: stats.replaced,
        savedChars, estimatedTokensSaved: estimateTokensSaved(savedChars),
        averageMs: !statsBaselineIsFresh(stats) ? null :
          roundedAverage(stats.elapsedMs, stats.timed), timed: stats.timed, elapsedMs: stats.elapsedMs, ...lineStats };
    }
    return withPublication(directory,journal => retainedStats(directory,{...totals},journal?.state === "prepared" ? journal.event_offset : null));
  }

  async function retainedStats(directory, totals, committedOffset) {
    const filename = await activityLogPath(directory);
    let file;
    try {
      const details = await fs.lstat(filename);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error("Unsafe Decision decision log");
      file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    } catch (error) {
      if (error.code === "ENOENT") return totals;
      throw error;
    }
    try {
      const details = await file.stat();
      if (!details.isFile()) throw new Error("Unsafe Decision decision log");
      const visible = committedOffset === null ? details.size : Math.min(details.size,committedOffset);
      if (visible === 0) return totals;
      Object.defineProperty(totals,"retainedActivity",{value:true});
      const start = Math.max(0,visible-1_048_576);
      Object.assign(totals,retainedStatsFromEvents(await readFileRange(file,visible-start,start),start>0));
    } finally {
      await file.close();
    }
    totals.estimatedTokensSaved = estimateTokensSaved(totals.savedChars);
    totals.averageMs = totals.retainedActivity ? null : 0;
    return totals;
  }

  // Match the bounded Rust retained-event reader. Corrupted rows cannot supply
  // partial completions or rounded counters, and EOF is not a commit boundary.
  function retainedStatsFromEvents(bytes, truncated = false) {
    const totals = {calls:0,completed:0,replaced:0,timed:0,elapsedMs:0,savedChars:0};
    const begin = truncated ? bytes.indexOf(10)+1 || bytes.length : 0;
    const end = Math.max(begin,bytes.lastIndexOf(10)+1);
    const unsigned = ["requests","elapsed_ms","original_chars","capsule_chars","lines_judged",
      "lines_relevance_judged","lines_relevance_kept"];
    const add = (name,amount) => {
      const next = totals[name]+amount;
      if (!Number.isSafeInteger(next) || next < 0) throw new Error("Decision retained activity exceeds the exact numeric range");
      totals[name] = next;
    };
    let from = begin;
    while (from < end) {
      const next = bytes.indexOf(10,from);
      const row = bytes.subarray(from,next);from=next+1;
      if (row.length > 8192) continue;
      let event;
      try {
        event = parseUnsignedJson(row,keys=>keys.length === 1 && unsigned.includes(keys[0]),
          keys=>keys.length === 1 && unsigned.includes(keys[0]) && keys[0] !== "requests");
        if (!event || typeof event.status !== "string" || typeof event.reason !== "string" ||
            unsigned.some(name=>event[name] !== undefined && event[name] !== null &&
              (!Number.isSafeInteger(event[name]) || event[name] < 0 || name === "requests" && event[name]>10_001))) continue;
      } catch (error) {if (error.code === "DECISION_COUNTER_RANGE") throw error;continue;}
      const requests=event.requests ?? 0;
      add("calls",event.status === "calling" ? 1 : requests);
      if ((isDecisionOutcome(event) || event.reason === "choice_kept_full_output") && event.elapsed_ms>0) {
        add("timed",requests || 1);add("elapsedMs",event.elapsed_ms);
      }
      if (!isDecisionOutcome(event)) continue;
      add("completed",1);
      if (event.status === "replace") {
        add("replaced",1);add("savedChars",savedCharacters(event));
      }
    }
    return totals;
  }

  function statsBaselineIsFresh(stats) {
    return stats?.counter_scheme === 1 && !Object.entries(stats).some(
      ([name,value])=>name.startsWith("partial_") && value === 1);
  }

  function roundedAverage(elapsed, timed) {
    if (!timed) return 0;
    const remainder = elapsed % timed;
    return (elapsed - remainder) / timed + Number(remainder >= Math.ceil(timed / 2));
  }

  return { readInstallationStats, readSessionActivityUncached, readLifetimeStats, retainedStatsFromEvents };
};
