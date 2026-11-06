"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readEventOffset, readEventsSince, readLifetimeStats } = require("../../../vscode-control/core");

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
