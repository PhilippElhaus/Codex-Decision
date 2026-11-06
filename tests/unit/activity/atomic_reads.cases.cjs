"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readSessionActivity, readRecentOutcomes } = require("../../../vscode-control/core");

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
