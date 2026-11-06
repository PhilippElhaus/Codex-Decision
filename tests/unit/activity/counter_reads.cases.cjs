"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readHookHealth, readSessionActivity, readRecentOutcomes } = require("../../../vscode-control/core");

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
