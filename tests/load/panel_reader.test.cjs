"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readLatestPanelDecision } = require("../../vscode-control/panel-state");

test("concurrent panel readers recover repeated atomic snapshot replacements", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-panel-atomic-"));
  const filename = path.join(directory, "logs/latest-decision.json");
  const decision = (sequence) => ({ version: 4, id: sequence.toString(16).padStart(32, "0"),
    receipt_id: "b".repeat(32), at: "2020-01-01T00:00:00Z", filter: "output", status: "keep",
    batch: { number: 1, count: 1, target_count: 2 }, batch_elapsed_ms: 20,
    rows: [{ line: 1, excerpt: `Synthetic revision ${sequence}`, action: "omit",
      reason: "irrelevant", task_relevant: .01 },
    { line: 2, excerpt: "Synthetic required diagnostic", action: "keep",
      reason: "task_relevant", task_relevant: .99 }],
    totals: { seen: 2, judged: 2, kept: 1, omitted: 1, protected: 0, unjudged: 0, requests: 2 } });
  try {
    await fs.mkdir(path.dirname(filename));
    await fs.writeFile(filename, JSON.stringify(decision(1)));
    let done = false;
    const writer = (async () => {
      try {
        for (let sequence = 2; sequence <= 200; sequence += 1) {
          const temporary = filename + ".new";
          await fs.writeFile(temporary, JSON.stringify(decision(sequence)));
          // The real hook writes from Linux. Let this native Windows fixture
          // wait for transient reader handles before replacing its test file.
          for (let attempts = 0; ; attempts += 1) {
            try { await fs.rename(temporary, filename); break; }
            catch (error) {
              if (process.platform !== "win32" || attempts >= 20 ||
                  !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          }
        }
      } finally { done = true; }
    })();
    const readers = Array.from({ length: 8 }, async () => {
      const cache = {};
      let previous = 0;
      let reads = 0;
      do {
        const current = await readLatestPanelDecision(directory, cache);
        const sequence = Number.parseInt(current.id, 16);
        assert.ok(sequence >= previous, "each reader must advance without replaying an older revision");
        assert.equal(current.rows[0].excerpt, `Synthetic revision ${sequence}`);
        assert.equal(current.rows[1].excerpt, "Synthetic required diagnostic");
        previous = sequence;
        reads += 1;
      } while (!done);
      assert.equal((await readLatestPanelDecision(directory, cache)).id, decision(200).id);
      return reads;
    });
    const results = await Promise.allSettled([writer, ...readers]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    assert.ok(results.slice(1).every(result => result.value > 0));
    assert.deepEqual(await fs.readdir(path.dirname(filename)), ["latest-decision.json"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
