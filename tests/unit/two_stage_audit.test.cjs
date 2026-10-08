"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { requireProxyHook, auditRun } = require("../../scripts/two_stage_audit.cjs");

const successful = () => ({ item: { kind: "repetitive_log" }, calls: 2,
  stages: ["classification", "relevance"], receipt: { manifest: { requests: 2, choice_gate_ran: true, status: "replace" } },
  health: { seen: 1, api_requests: 2, errors: 0 }, stats: { calls: 2, completed: 1, replaced: 1 },
  activity: { requests: 2 }, error: null, replaced: true, live: false });

test("the runner refuses a production hook before sending dummy requests", () => {
  assert.throws(() => requireProxyHook(Buffer.from("production executable")), /requires a debug hook/);
  assert.doesNotThrow(() => requireProxyHook(Buffer.from("debug executable CODEX_DECISION_TEST_ENDPOINT")));
});

test("completed decisions reconcile classification, relevance, receipt and health counts", () => {
  const result = auditRun(successful());
  assert.deepEqual(result.failures, []);
  assert.equal(result.classification_attempts, 1);
  assert.equal(result.relevance_attempts, 1);
  assert.equal(result.recorded_requests, 2);
  assert.equal(result.outcome, "evaluated");
  const broken = successful();broken.health.api_requests = 1;
  assert.ok(auditRun(broken).failures.includes("proxy_request_count_differs_from_hook_health"));
  assert.ok(auditRun(broken).abort);
  broken.health.api_requests = 2;broken.receipt.manifest.requests = 1;
  assert.ok(auditRun(broken).failures.includes("receipt_request_counts_differ_from_proxy"));
});

test("ordinary eligible output cannot pass after a silent local skip", () => {
  const run = { ...successful(), calls: 0, stages: [], receipt: null, health: { seen: 1, errors: 0, last_skip: "sensitive" },
    stats: null, activity: null, replaced: false };
  assert.ok(auditRun(run).failures.includes("eligible_output_silently_skipped"));
  run.item = { kind: "repetitive_log", expect_full: true, expected_calls: 0, expected_skip: "sensitive" };
  assert.deepEqual(auditRun(run).failures, []);
  assert.equal(auditRun(run).outcome, "intended_local_skip");
});

test("classification-only keeps count one request without publishing a line decision", () => {
  const run = { ...successful(), item: { kind: "prose", expect_full: true }, calls: 1, stages: ["classification"],
    receipt: null, health: { seen: 1, errors: 0, api_requests: 1, last_skip: "choice_kept_full_output" },
    stats: { calls: 1, completed: 0, replaced: 0 }, activity: { requests: 1 }, replaced: false };
  assert.deepEqual(auditRun(run).failures, []);
  assert.equal(auditRun(run).outcome, "classification_keep");
  run.item = { kind: "repetitive_log" };
  assert.ok(auditRun(run).failures.includes("eligible_output_silently_skipped"));
  run.live = true;
  assert.deepEqual(auditRun(run).failures, []);
  assert.equal(auditRun(run).outcome, "classification_keep");
  run.item.expected_decision = true;
  assert.ok(auditRun(run).failures.includes("eligible_output_silently_skipped"));
});

test("a failed later batch retains attempt counts but no completion statistics", () => {
  const run = { ...successful(), item: { kind: "repetitive_log", fault: "line-late-http500" }, calls: 3,
    stages: ["relevance", "relevance", "relevance"], receipt: null, health: { seen: 1, api_requests: 3, errors: 1 },
    stats: null, activity: { requests: 0 }, error: "Decision request failed", replaced: false };
  assert.deepEqual(auditRun(run).failures, []);
  assert.equal(auditRun(run).outcome, "error");
  run.item = { kind: "repetitive_log" };run.live = true;
  assert.ok(auditRun(run).failures.includes("unexpected_hook_error"));
  assert.ok(auditRun(run).abort);
});

test("request stages and error counters cannot hide failed or duplicated evaluations", () => {
  const run = successful();run.stages.reverse();
  assert.ok(auditRun(run).failures.includes("invalid_request_stage_sequence"));
  run.stages = ["classification", "relevance"];run.health.errors = 1;
  assert.ok(auditRun(run).failures.includes("error_count_differs_from_observed_error"));
});

test("current request outcomes reconcile validated completions and stop live work after a lost outcome", () => {
  const run = successful();
  Object.assign(run.health, { counter_scheme: 1, responses_received: 2, responses_validated: 2,
    request_failures: 0, request_cancelled: 0 });
  assert.deepEqual(auditRun(run).failures, []);
  run.health.responses_validated = 1;
  run.live = true;
  assert.ok(auditRun(run).failures.includes("request_outcome_counts_not_reconciled"));
  assert.ok(auditRun(run).abort);
  run.health.request_failures = 1;
  assert.ok(auditRun(run).failures.includes("request_outcome_counts_not_reconciled"), "a committed completion cannot hide a failed request");
  run.receipt = null;
  run.error = "Decision request failed";
  run.item.fault = "line-late-http500";
  run.stats = { calls: 0, completed: 0, replaced: 0 };
  run.activity = { requests: 0 };
  run.health.errors = 1;
  run.replaced = false;
  assert.deepEqual(auditRun(run).failures, []);
});

test("monitor and missing-context previews must still publish their evaluated decision", () => {
  const run = successful();run.item = { kind: "repetitive_log", expect_full: true, expected_decision: true };
  run.receipt.manifest.status = "candidate";run.replaced = false;run.stats.replaced = 0;
  assert.deepEqual(auditRun(run).failures, []);
  assert.equal(auditRun(run).outcome, "preview");
  run.receipt = null;run.stats.completed = 0;
  assert.ok(auditRun(run).failures.includes("eligible_output_silently_skipped"));
});
