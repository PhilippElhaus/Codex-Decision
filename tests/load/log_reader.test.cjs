"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readEventCursor, readEventsSince, readLifetimeStats } = require("../../vscode-control/core");

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

test("activity cursors recover atomic compaction and copy truncation without duplicate retained events", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-log-rotation-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    const filename = path.join(directory, "logs/events.jsonl");
    const row = (id) => JSON.stringify({ id, status: "keep", reason: "fixture", tool: id,
      original_chars: 1000, padding: "x".repeat(400) }) + "\n";
    const first = row("first"), second = row("second"), third = row("third"), fourth = row("fourth");
    await fs.writeFile(filename, first);
    let cursor = await readEventCursor(directory);
    await fs.appendFile(filename, second);
    let batch = await readEventsSince(directory, cursor);
    assert.deepEqual(batch.events.map(event => event.tool), ["second"]);
    cursor = batch.cursor;
    await fs.writeFile(filename + ".new", second + third + fourth);
    await fs.rename(filename + ".new", filename);
    batch = await readEventsSince(directory, cursor);
    assert.equal(batch.reset, true);
    assert.deepEqual(batch.events.map(event => event.tool), ["third", "fourth"]);
    cursor = batch.cursor;
    await fs.writeFile(filename, fourth + row("fifth"));
    batch = await readEventsSince(directory, cursor);
    assert.equal(batch.reset, true);
    assert.deepEqual(batch.events.map(event => event.tool), ["fifth"]);
    cursor = batch.cursor;
    await fs.writeFile(filename + ".new", row("different") + row("replacement"));
    await fs.rename(filename + ".new", filename);
    batch = await readEventsSince(directory, cursor);
    assert.deepEqual(batch.events.map(event => event.tool), ["different", "replacement"]);
    assert.deepEqual((await readEventsSince(directory, batch.cursor)).events, []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("fallback latency counts request timings across line batches and Choice skips", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-log-latency-"));
  try {
    await fs.mkdir(path.join(directory, "logs"));
    const events = [
      { status: "keep", reason: "fixture", requests: 3, elapsed_ms: 900 },
      { status: "replace", reason: "fixture", requests: 2, elapsed_ms: 200 },
      { status: "skip", reason: "choice_kept_full_output", requests: 1, elapsed_ms: 100 },
    ];
    await fs.writeFile(path.join(directory, "logs/events.jsonl"), events.map(row => JSON.stringify(row)).join("\n") + "\n");
    const totals = await readLifetimeStats(directory);
    assert.equal(totals.calls, 6);
    assert.equal(totals.completed, 2);
    assert.equal(totals.timed, 6);
    assert.equal(totals.averageMs, 200);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
