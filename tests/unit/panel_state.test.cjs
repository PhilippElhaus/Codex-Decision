"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parsePanelDecision, readLatestPanelDecision } = require("../../vscode-control/panel-state");

const snapshot = {
  version: 1, id: "a".repeat(32), at: "2026-09-28T12:34:56.123456+00:00",
  filter: "output", status: "replace", call_index: 1, call_count: 1,
  choices: [{ name: "filter_decision", selected: "filter", probabilities: { filter: 0.83, keep: 0.17 } }],
  checks: [{ name: "routine_noise", probability: 0.91 }],
  recent: [{ id: "a".repeat(32), theme: "output_filter", elapsed_ms: 48 }],
};

test("panel state accepts only fixed labels and bounded probability values", () => {
  assert.equal(parsePanelDecision(snapshot).choices[0].selected, "filter");
  assert.equal(parsePanelDecision(snapshot).recent[0].elapsed_ms, 48);
  assert.throws(() => parsePanelDecision({ ...snapshot, choices: [
    { name: "private path", selected: "filter", probabilities: { filter: 0.83, keep: 0.17 } },
  ] }), /choice/);
  assert.throws(() => parsePanelDecision({ ...snapshot, choices: [
    { name: "filter_decision", selected: "filter", probabilities: { filter: 1.2, keep: -0.2 } },
  ] }), /probability/);
  assert.equal(parsePanelDecision({ ...snapshot, recent: undefined }).recent.length, 0);
  assert.throws(() => parsePanelDecision({ ...snapshot, recent: [
    { id: "a".repeat(32), theme: "private path", elapsed_ms: 48 },
  ] }), /history/);
  assert.throws(() => parsePanelDecision({ ...snapshot, recent: [
    { id: "a".repeat(32), theme: "output_filter", elapsed_ms: -1 },
  ] }), /history/);
  assert.throws(() => parsePanelDecision({ ...snapshot, recent: [
    { id: "a".repeat(32), theme: "output_filter", elapsed_ms: 4.92 },
  ] }), /history/);
  assert.throws(() => parsePanelDecision({ ...snapshot, recent: [
    { id: "a".repeat(32), theme: "output_filter", elapsed_ms: 3_600_001 },
  ] }), /history/);
  assert.throws(() => parsePanelDecision({ ...snapshot, recent: [
    { id: "b".repeat(32), theme: "output_filter", elapsed_ms: 48 },
  ] }), /history/);
});

test("panel reads the current snapshot and rejects linked files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-panel-test-"));
  try {
    assert.equal(await readLatestPanelDecision(directory), null);
    const logs = path.join(directory, "logs");
    await fs.mkdir(logs);
    const filename = path.join(logs, "latest-decision.json");
    await fs.writeFile(filename, JSON.stringify(snapshot));
    assert.equal(await readLatestPanelDecision(directory), null, "legacy v1 entries do not populate the live panel");
    const latest = { id: `${snapshot.id}-12`, line: 12, excerpt: "test passed", summary: "test/build · line 12",
      action: "keep", can_omit: 0.81, exact_needed: 0.2 };
    const version2 = { version: 2, id: snapshot.id, at: snapshot.at, filter: "test_build", status: "keep",
      latest, recent: [latest], totals: { seen: 12, judged: 10, kept: 12, omitted: 0,
        protected: 2, unjudged: 2, requests: 1 }, batch_elapsed_ms: 48 };
    await fs.writeFile(filename, JSON.stringify(version2));
    assert.equal((await readLatestPanelDecision(directory)).latest.line, 12);
    assert.equal(parsePanelDecision({ ...version2, status: "processing" }).status, "processing");
    assert.throws(() => parsePanelDecision({ ...version2, latest: { ...latest, can_omit: 1.2 } }), /line row/);
    const searchLine = { ...latest, task_relevant: 0.84, reason: "task_relevant" };
    const searchPanel = { ...version2, filter: "search_listing", latest: searchLine, recent: [searchLine] };
    assert.equal(parsePanelDecision(searchPanel).latest.task_relevant, 0.84);
    assert.throws(() => parsePanelDecision({ ...searchPanel, latest: { ...searchLine, task_relevant: 1.2 } }), /line row/);
    const rows = Array.from({ length: 250 }, (_, index) => ({ line: index + 1,
      excerpt: `Synthetic source line ${index + 1} ${"x".repeat(90)}`, action: "keep",
      reason: "below_omit_cutoff", can_omit: 0.3, exact_needed: 0.2, task_relevant: null }));
    const version3 = { version: 3, id: snapshot.id, receipt_id: "b".repeat(32),
      at: snapshot.at, filter: "search_listing", status: "keep",
      batch: { number: 1, count: 1, target_count: 250 }, rows,
      totals: { seen: 250, judged: 250, kept: 250, omitted: 0, protected: 0, unjudged: 0, requests: 1 },
      batch_elapsed_ms: 48 };
    assert.ok(Buffer.byteLength(JSON.stringify(version3)) > 16_384);
    await fs.writeFile(filename, JSON.stringify(version3));
    assert.equal((await readLatestPanelDecision(directory)).rows.length, 250);
    const mixed = { ...version3, batch: { ...version3.batch, target_count: 3 },
      rows: [
        { ...rows[0], can_omit: .98, exact_needed: .94, reason: "exact_text" },
        { ...rows[1], can_omit: .98, exact_needed: .02, task_relevant: .96, reason: "task_relevant" },
        { ...rows[2], action: "omit", can_omit: .98, exact_needed: .02,
          task_relevant: .03, reason: "confident_omission" },
      ], totals: { ...version3.totals, kept: 249, omitted: 1 } };
    const [exact, relevant, cut] = parsePanelDecision(mixed).rows;
    assert.ok(exact.retention_index > .95);
    assert.ok(relevant.retention_index > .95);
    assert.ok(cut.retention_index < .05);
    assert.equal(parsePanelDecision({ ...version3,
      batch: { ...version3.batch, number: 13, count: 20 },
      totals: { ...version3.totals, requests: 13 } }).batch.number, 13);
    assert.throws(() => parsePanelDecision({ ...version3, rows: [...rows, rows[0]],
      batch: { ...version3.batch, target_count: 251 } }), /batch decision/);
    assert.throws(() => parsePanelDecision({ ...version3, rows: rows.map((row, index) =>
      index === 0 ? { ...row, can_omit: 1.2 } : row) }), /probability/);
    assert.throws(() => parsePanelDecision({ ...version3, rows: rows.map((row, index) =>
      index === 1 ? { ...row, line: 1 } : row) }), /batch row/);
    await fs.rename(filename, path.join(directory, "owned.json"));
    await fs.symlink(path.join(directory, "owned.json"), filename);
    await assert.rejects(readLatestPanelDecision(directory), /Unsafe/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
