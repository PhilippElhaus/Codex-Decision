"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readEventsSince, readLifetimeStats } = require("../../vscode-control/core");

test("a large decision log is read in bounded batches without loss or duplication", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-log-load-"));
  try {
    const count = 6000;
    const rows = Array.from({ length: count }, (_, index) => JSON.stringify({
      tool: "Bash", filter: "output", status: ["calling", "replace", "keep", "candidate"][index % 4],
      reason: "load_fixture", original_chars: 1000 + index,
      capsule_chars: index % 4 === 1 ? 200 : 0, elapsed_ms: 10,
    }));
    const body = rows.join("\n") + "\n";
    await fs.mkdir(path.join(directory, "logs"));
    await fs.writeFile(path.join(directory, "logs", "events.jsonl"), body);
    let offset = 0;
    const seen = [];
    while (offset < Buffer.byteLength(body)) {
      const batch = await readEventsSince(directory, offset);
      assert.equal(batch.reset, false);
      assert.ok(batch.offset > offset && batch.offset - offset <= 262144);
      seen.push(...batch.events.map((event) => event.original_chars));
      offset = batch.offset;
    }
    assert.deepEqual(seen, Array.from({ length: count }, (_, index) => 1000 + index));
    const lifetime = await readLifetimeStats(directory);
    assert.equal(lifetime.calls, 1500);
    assert.equal(lifetime.completed, 4500);
    assert.equal(lifetime.replaced, 1500);
    assert.equal(lifetime.averageMs, 10);

  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
