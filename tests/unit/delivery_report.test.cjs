"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { summarize, readDeliveryReport } = require("../../vscode-control/delivery-report");
const key = n => n.toString(16).padStart(64, "0");
const model = (turn, mode, tokens = 100) => ({ event: "model_request", turn_key: key(turn), mode, status: "completed",
  usage: { input_tokens: tokens, output_tokens: 5, cached_tokens: 40 } });

test("usage correlation keeps mixed modes, retries, and unknown usage separate from savings", () => {
  const rows = [model(1, "observe", 200), model(2, "replace", 120), model(2, "replace", 80),
    { event: "tool_output", turn_key: key(2), mode: "replace", prepared_replacement: true },
    model(3, "replace"), model(3, "observe"), { ...model(4, "replace"), usage: null },
    { ...model(5, "replace"), turn_key: null }];
  const result = summarize(rows, [{ event: "request", input_tokens: 100, output_tokens: 0, cached_tokens: 60, cache_write_tokens: 30 }]);
  assert.equal(result.modes.replace.attempts, 3);
  assert.equal(result.modes.replace.turns, 2);
  assert.equal(result.modes.replace.missing_usage, 1);
  assert.equal(result.modes.replace.prepared_replacements, 1);
  assert.equal(result.modes.unattributed.attempts, 3);
  assert.equal(result.observational_input_difference_per_attempt, 100);
  assert.equal(result.decision.input_tokens, 100);
  assert.equal(result.decision.cached_tokens, 60);
  assert.equal(result.decision.cache_write_tokens, 30);
  assert.equal(result.delivery, "unverified");
  assert.equal(result.causal_savings, null);
  assert.equal(result.estimated_cost_usd, null);
  const unknown = summarize([{ ...model(1, "observe"), usage: null }]);
  assert.equal(unknown.modes.observe.input_tokens, null);
  assert.equal(unknown.modes.observe.cached_tokens, null);
});

test("invalid, partial, unsafe, and inexact metadata cannot become zero-cost success", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-delivery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "logs"), { mode: 0o700 });
  const row = { ...model(1, "observe"), version: 1, at: "2026-11-11T12:00:00Z" };
  const filename = path.join(directory, "logs/model-requests.jsonl");
  await fs.writeFile(filename, JSON.stringify(row) + '\n{"version":1,"version":2}\n{"partial":', { mode: 0o600 });
  const report = await readDeliveryReport(directory);
  assert.equal(report.gaps.invalid_rows, 1);
  assert.equal(report.gaps.incomplete_rows, 1);
  assert.equal(report.gaps.missing_files, 2);
  assert.equal(report.modes.observe.attempts, 1);
  assert.equal(report.observational_input_difference_per_attempt, null);
  const huge = summarize([model(1, "replace", Number.MAX_SAFE_INTEGER), model(1, "replace", 1)]);
  assert.equal(huge.modes.replace.input_tokens, null);
  assert.equal(huge.gaps.inexact_totals, 1);
  if (process.platform !== "win32") {
    await fs.chmod(filename, 0o644);
    await assert.rejects(readDeliveryReport(directory), /Unsafe Decision private record/);
  }
});
