"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { audit, reconcileRollouts, addEvent, addActivity, emptyEvents, readEvents } = require("../../scripts/usage_effectiveness_audit.cjs");
const cases = require("../fixtures/activity-accounting.json");
const fixture = cases.find(item => item.name === "current_exact");
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const session = "11111111-1111-1111-1111-111111111111";

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-usage-test-"));
  t.after(() => fs.rm(root, { recursive: true }));
  return root;
}
async function write(filename, data) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
}
async function linkDirectory(target, link) {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
const rollout = (...records) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

test("audit preserves exact and partial coverage without reading credentials or private text", async t => {
  const root = await temporary(t), data = path.join(root, "data");
  const exact = path.join(data, "sessions", sha(session));
  const legacy = path.join(data, "sessions", sha("legacy"));
  const receiptId = "a".repeat(32), original = path.join(data, "outputs", "b".repeat(20), "c".repeat(20) + ".txt");
  const visible = `[Codex Decision: 6 of 10 lines omitted; full original: ${original}]\nkept`;
  await write(path.join(exact, "stats.json"), fixture.stats);
  await write(path.join(exact, "logs/hook-health.json"), fixture.health);
  await write(path.join(exact, "logs/events.jsonl"), rollout({ status: "replace", reason: "relevance_policy", tool: "Bash",
    id: receiptId, requests: 2, lines_omitted: 6, original_chars: 1000, capsule_chars: 400, at: "2026-10-16T12:00:00Z",
    source_sha256: sha("PRIVATE_SENTINEL"), private_task: "PRIVATE_SENTINEL" }));
  await write(original, "PRIVATE_SENTINEL");
  await write(path.join(exact, "logs", "2026-10-16-" + sha(session).slice(0, 10), `receipt-${receiptId}.json`), {
    manifest: { id: receiptId, status: "replace", provider: "openai" }, tool: "Bash", initial_output: "PRIVATE_SENTINEL", visible_output: visible });
  await write(path.join(exact, "logs", "2026-10-15-" + sha(session).slice(0, 10), `receipt-${receiptId}.json`), {
    manifest: { id: receiptId, status: "replace", provider: "openai" }, tool: "Bash", initial_output: "PRIVATE_SENTINEL", visible_output: visible });
  await write(path.join(exact, "logs", "2026-10-16-" + sha(session).slice(0, 10), `receipt-${"d".repeat(32)}.json`), {
    manifest: { status: "replace", provider: "PRIVATE_SENTINEL" }, tool: "PRIVATE_SENTINEL", initial_output: "PRIVATE_SENTINEL", visible_output: "uncommitted" });
  await write(path.join(legacy, "stats.json"), { calls: 1, completed: 0, replaced: 0, elapsedMs: 10, timed: 1 });
  await write(path.join(legacy, "logs/hook-health.json"), { version: 1, hook_version: "0.10.7", last_seen_ms: 1, skipped: 5 });
  const credentialTrap = path.join(root, "credential-must-not-be-read");
  await fs.mkdir(credentialTrap, { mode: 0o700 });
  await linkDirectory(credentialTrap, path.join(data, ".env"));
  const before = await fs.readFile(path.join(exact, "stats.json"));
  const result = await audit({ dataDirectory: data, observationDate: "2026-10-16" });
  assert.equal(result.session_count, 2);
  assert.equal(result.exact_health_scopes.scopes, 1);
  assert.deepEqual(result.exact_health_scopes.metrics.calls, { recorded: 6, known_scopes: 1, partial_scopes: 0, unknown_scopes: 0 });
  assert.equal(result.session_scopes.metrics.calls.recorded, 7);
  assert.equal(result.session_scopes.metrics.calls.partial_scopes, 1);
  assert.equal(result.retained_events.replacement_omitted_lines, 6);
  assert.equal(result.retained_events.distinct_replacement_source_hashes, 1);
  assert.equal(result.retained_replacement_receipts.records, 1);
  assert.equal(result.retained_replacement_receipts.duplicate_receipt_files, 1);
  assert.equal(result.retained_replacement_receipts.verified_saved_original, 1);
  assert.equal(result.retained_replacement_receipts.original_content_mismatch, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE_SENTINEL"), false);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.deepEqual(await fs.readFile(path.join(exact, "stats.json")), before);
  assert.ok(result.limits.some(text => text.includes("not prove absent model-visible")));
});

test("unknown event strings and counter-map names never become exported identifiers", () => {
  const events = emptyEvents();
  addEvent(events, { status: "PRIVATE_SENTINEL", reason: "PRIVATE_SENTINEL" });
  addEvent(events, { status: "candidate", reason: "PRIVATE_SENTINEL", tool: "PRIVATE_SENTINEL", routing: "PRIVATE_SENTINEL",
    provider: "PRIVATE_SENTINEL", lines_omitted: 5, original_chars: 1000, capsule_chars: 10 });
  assert.equal(events.proposed_omitted_lines, 5);
  assert.equal(events.replacement_omitted_lines, 0);
  addEvent(events, { status: "replace", reason: "relevance_policy", fallback_used: true, provider: "typesafe", configured_provider: "openai" });
  addEvent(events, { status: "keep", reason: "no_omissions", fallback_used: false, provider: "openai" });
  addEvent(events, { status: "replace", reason: "relevance_policy", provider: "openai" });
  assert.deepEqual(events.fallback_completed_outcomes, { used: 1, not_used: 1, unknown: 2 });
  assert.deepEqual(events.fallback_completed_replacements, { used: 1, not_used: 0, unknown: 1 });
  assert.deepEqual(events.fallback_actual_providers, { typesafe: 1 });
  assert.deepEqual(events.fallback_configured_providers, { openai: 1 });
  const summary = { scopes: 0, metrics: {}, skip_reasons: {}, skip_details: {}, candidate_reasons: {} };
  addActivity(summary, { partialCounters: [], skipCounts: { PRIVATE_SENTINEL: 1 }, skipDetails: {}, candidateReasons: {} });
  assert.equal(JSON.stringify({ events, summary }).includes("PRIVATE_SENTINEL"), false);
});

test("malformed counters and fallback metadata contribute no partial outcome metrics", async t => {
  const root = await temporary(t), summary = emptyEvents();
  await write(path.join(root, "logs/events.jsonl"), rollout(
    { status: "replace", reason: "relevance_policy", tool: "Bash", requests: -1, lines_omitted: 10 },
    { status: "replace", reason: "relevance_policy", tool: "Bash", requests: 1, api_usage: { input_tokens: -4, output_tokens: 2 } },
    { status: "replace", reason: "relevance_policy", tool: "Bash", requests: 1, lines_omitted: -5 },
    { status: "replace", reason: "relevance_policy", tool: "Bash", requests: 1, fallback_used: "false" },
    { status: "replace", reason: "relevance_policy", tool: "Bash", requests: 1, fallback_used: null }));
  await readEvents(root, summary);
  assert.equal(summary.malformed_records, 5);
  assert.equal(summary.records, 0);
  assert.deepEqual(summary.outcomes, {});
  assert.deepEqual(summary.replacements_by_tool, {});
  assert.equal(summary.requests, 0);
  assert.deepEqual(summary.fallback_completed_outcomes, { used: 0, not_used: 0, unknown: 0 });
});

test("a publication retry contributes only its stable event snapshot", async t => {
  const root = await temporary(t), summary = emptyEvents();
  await write(path.join(root, "logs/events.jsonl"), rollout({ status: "replace", reason: "relevance_policy",
    id: "a".repeat(32), tool: "Bash", requests: 2, elapsed_ms: 40, lines_omitted: 5 }));
  let reads = 0;
  const replacements = await readEvents(root, summary, async (_directory, callback) => {
    await callback(null); reads += 1;
    const stable = await callback(null); reads += 1;
    return stable;
  });
  assert.equal(reads, 2);
  assert.equal(summary.records, 1);
  assert.equal(summary.requests, 2);
  assert.equal(summary.elapsed_ms, 40);
  assert.equal(summary.replacement_omitted_lines, 5);
  assert.equal(replacements.size, 1);
});

test("rollout reconciliation owns filenames, deduplicates copies, and ignores quoted marker literals", async t => {
  const root = await temporary(t);
  const content = rollout(
    { type: "session_meta", payload: { id: "parent-history-id", cli_version: "0.162.0-alpha.17.2" } },
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call_a" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_a", output: "PRIVATE_SENTINEL" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_b",
      output: "[Codex Decision: 6 of 10 lines omitted; full original: /PRIVATE_SENTINEL/original.txt]\nkept" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_c",
      output: 'source: "[Codex Decision: 6 of 10 lines omitted; full original: /PRIVATE_SENTINEL/original.txt]"' } });
  await write(path.join(root, `rollout-${session}.jsonl`), content);
  await write(path.join(root, "copy", `rollout-${session}.jsonl`), content);
  const fork = "22222222-2222-2222-2222-222222222222";
  await write(path.join(root, `rollout-${fork}.jsonl`), content);
  await write(path.join(root, "unmatched.jsonl"), content);
  const result = await reconcileRollouts(root, new Set([sha(session), sha(fork)]));
  assert.equal(result.matched_session_files, 3);
  assert.equal(result.matched_session_scopes, 2);
  assert.equal(result.tool_result_items, 9);
  assert.equal(result.unique_tool_result_items, 6);
  assert.equal(result.global_unique_tool_result_items, 3);
  assert.equal(result.inherited_or_repeated_tool_result_items, 3);
  assert.equal(result.duplicate_tool_result_items, 3);
  assert.equal(result.tool_calls.exec, 2);
  assert.equal(result.omission_headers, 2);
  assert.equal(result.tool_results_with_omission_headers, 2);
  assert.equal(result.versions["0.162.0-alpha.17.2"], 2);
  assert.equal(JSON.stringify(result).includes("PRIVATE_SENTINEL"), false);
});

test("rollout records are bounded before decoding and linked inputs are not traversed", async t => {
  const root = await temporary(t), outside = await temporary(t);
  const filename = path.join(root, `rollout-${session}.jsonl`);
  await write(filename, "x".repeat(20 * 1024 * 1024 + 1) + "\n" + rollout(
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "safe", output: "kept" } }) + "partial");
  await write(path.join(outside, `rollout-${session}.jsonl`), "PRIVATE_SENTINEL\n");
  await linkDirectory(outside, path.join(root, "linked"));
  const result = await reconcileRollouts(root, new Set([sha(session)]));
  assert.equal(result.files_considered, 1);
  assert.equal(result.oversized_records, 1);
  assert.equal(result.malformed_records, 0);
  assert.equal(result.incomplete_records, 1);
  assert.equal(result.tool_result_items, 1);
  assert.equal(result.omission_headers, 0);
  await assert.rejects(reconcileRollouts(path.join(root, "linked"), new Set()), /Unsafe/);
});
