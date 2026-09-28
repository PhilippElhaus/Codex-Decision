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
    assert.equal((await readLatestPanelDecision(directory)).id, snapshot.id);
    await fs.rename(filename, path.join(directory, "owned.json"));
    await fs.symlink(path.join(directory, "owned.json"), filename);
    await assert.rejects(readLatestPanelDecision(directory), /Unsafe/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
