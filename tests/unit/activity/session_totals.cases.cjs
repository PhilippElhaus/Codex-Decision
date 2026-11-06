"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decisionSummary, sessionDirectory, estimateTokensSaved, outcomeLine, readLifetimeStats, ensureSessionDefaults, readInstallationStats } = require("../../../vscode-control/core");

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
