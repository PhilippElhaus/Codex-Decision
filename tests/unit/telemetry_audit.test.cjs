"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { audit, consume, emptySummary, finish, readTelemetry } = require("../../scripts/telemetry_audit.cjs");
const { readFileRecord } = require("../../vscode-control/private-records");

const header = { version: 1, at: "2026-10-27T08:00:00Z", invocation_id: "a".repeat(32), hook_version: "0.15.0", runtime: "linux" };
const row = (event, fields = {}) => ({ ...header, event, ...fields });
const encode = rows => rows.map(value => JSON.stringify(value)).join("\n") + "\n";
const sample = () => [row("invocation_start", { tool_family: "shell", provider: "openai" }),
  row("request", { request_index: 1, stage: "classification", provider: "openai", elapsed_ms: 301,
    request_bytes: 4500, response_bytes: 700, http_status: 200, outcome: "validated", input_tokens: 300, output_tokens: 10 }),
  row("invocation", { elapsed_ms: 310, outcome: "skip", reason: "choice_kept_full_output", source_bytes: 2000, request_count: 1, fallback_used: false })];

test("metadata audit counts distinct outputs separately from attempts and bounded latency", () => {
  const summary = emptySummary();
  consume(encode([...sample(), row("request", { invocation_id: "b".repeat(32), request_index: 1,
    stage: "relevance", provider: "custom", outcome: "http_error", http_status: 429, elapsed_ms: 20 }),
  row("request", { invocation_id: "b".repeat(32), request_index: 2,
    stage: "relevance", provider: "custom", outcome: "validated", http_status: 200, elapsed_ms: 100 }),
  row("invocation", { invocation_id: "b".repeat(32), outcome: "replace", reason: "relevance_policy", elapsed_ms: 140,
    request_count: 2, fallback_used: true, prepared_saved_chars: 1000, proposed_omitted: 30 })]), summary);
  assert.equal(summary.requests, 3);
  assert.equal(summary.outputs_with_requests, 2);
  assert.equal(summary.completions_without_start, 1);
  assert.equal(summary.fallback_invocations, 1);
  assert.equal(summary.prepared_saved_chars, 1000);
  assert.equal(summary.proposed_omitted_lines, 30);
  assert.deepEqual(summary.http_statuses, { 200: 2, 429: 1 });
  assert.equal(summary.reported_input_tokens, 300);
  assert.equal(summary.usage_records, 1);
  const timing = finish(summary.request_latency);
  assert.equal(timing.count, 3);
  assert.equal(timing.p50_upper_ms, 128);
  assert.equal(timing.p95_upper_ms, 512);
  assert.equal(summary.delivery, "unverified");
});

test("malformed, duplicate, unknown, and private strings never become exported identifiers", () => {
  const summary = emptySummary(), privateValue = "PRIVATE_SENTINEL";
  consume(encode([row("invocation_start", { tool_family: privateValue, provider: privateValue, hook_version: privateValue,
    runtime: privateValue, endpoint: privateValue, command: privateValue }),
  row("invocation", { outcome: privateValue, reason: privateValue }),
  row("request", { request_index: 1, provider: privateValue, stage: privateValue, outcome: privateValue,
    error_code: privateValue, http_status: null }), row("invocation"), { version: 2, event: privateValue },
  row("request", { request_index: -1 })]) + '{"version":1,"version":1}\n', summary);
  assert.equal(summary.duplicate_records, 1);
  assert.equal(summary.unsupported_rows, 1);
  assert.equal(summary.malformed_rows, 2);
  assert.equal(JSON.stringify(summary).includes(privateValue), false);
  assert.equal(JSON.stringify(summary).includes(header.invocation_id), false);
});

test("window boundaries preserve incomplete correlation rather than inventing missing starts", () => {
  const summary = emptySummary(), rows = sample();
  rows[0].at = "2026-10-26T23:59:59Z";
  consume(encode(rows), summary, Date.parse("2026-10-27T00:00:00Z"));
  assert.equal(summary.starts, 0);
  assert.equal(summary.completions, 1);
  assert.equal(summary.completions_without_start, 1);
  assert.equal(summary.rows_outside_window, 1);
  const incomplete = emptySummary();
  consume(encode(rows.slice(0, 2)), incomplete);
  assert.equal(incomplete.starts_without_completion, 1);
  assert.equal(incomplete.requests_without_completion, 1);
  const missingRequest = emptySummary();
  consume(encode([rows[0], rows[2]]), missingRequest);
  assert.equal(missingRequest.completions_with_missing_request_rows, 1);
  assert.equal(missingRequest.request_rows_missing_at_least, 1);
});

test("current relevance counters retain their own measurement coverage", () => {
  const summary = emptySummary();
  consume(encode([row("invocation", { outcome: "candidate", lines_relevance_below_cutoff: 3,
    lines_restored_by_guards: 2, proposed_omitted: 1, prepared_omitted_lines: 0 }),
  row("invocation", { invocation_id: "b".repeat(32), outcome: "keep" })]), summary);
  assert.equal(summary.lines_relevance_below_cutoff, 3);
  assert.equal(summary.lines_restored_by_guards, 2);
  assert.equal(summary.prepared_omitted_lines, 0);
  assert.equal(summary.measured_fields.lines_relevance_below_cutoff, 1);
  assert.equal(summary.measured_fields.prepared_omitted_lines, 1);
});

test("invalid UTF-8 and rounded fractional counters cannot enter exact measurements", () => {
  const summary = emptySummary(), valid = encode([row("request", { request_index: 1, elapsed_ms: 1 })]);
  const fractional = valid.replace('"elapsed_ms":1', '"elapsed_ms":9007199254740990.9');
  const invalidUtf8 = Buffer.from(encode([row("invocation", { reason: "PRIVATE" })]));
  invalidUtf8[invalidUtf8.indexOf("PRIVATE")] = 255;
  consume(Buffer.concat([Buffer.from(fractional), invalidUtf8]), summary);
  assert.equal(summary.records, 0);
  assert.equal(summary.malformed_rows, 2);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-telemetry-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logs = path.join(root, "sessions", "b".repeat(64), "logs");
  await fs.mkdir(logs, { recursive: true, mode: 0o700 });
  return { root, logs };
}

test("offline CLI reader uses only metadata and leaves logs and credentials untouched", async t => {
  const { root, logs } = await fixture(t), text = encode(sample());
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_CREDENTIAL_SENTINEL", { mode: 0o000 });
  const filename = path.join(logs, "telemetry.jsonl");
  await fs.writeFile(filename, text + '{"partial":', { mode: 0o600 });
  const before = await fs.readFile(filename);
  const result = await audit(root, { since: "2026-10-27T00:00:00Z" });
  assert.equal(result.files_found, 1);
  assert.equal(result.incomplete_final_rows, 1);
  assert.equal(result.requests, 1);
  assert.equal(result.request_latency.p95_upper_ms, 512);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  assert.deepEqual(await fs.readFile(filename), before);
  await assert.rejects(audit(root, { since: "yesterday" }), /UTC ISO/);
});

test("bounded tail reader marks lost rows and rejects links", { skip: process.platform === "win32" }, async t => {
  const { root, logs } = await fixture(t);
  const filename = path.join(logs, "telemetry.jsonl");
  await fs.writeFile(filename, "x".repeat(4 * 1024 * 1024 + 20) + "\n" + encode(sample()), { mode: 0o600 });
  const result = await audit(root);
  assert.equal(result.tail_limited_files, 1);
  assert.equal(result.starts, 1);
  await fs.unlink(filename);
  await fs.symlink(path.join(root, ".env"), filename);
  await assert.rejects(audit(root), /Unsafe/);
});

test("concurrent file changes retry a bounded number of times then report an unstable file", async t => {
  const { logs } = await fixture(t), filename = path.join(logs, "telemetry.jsonl");
  await fs.writeFile(filename, encode(sample()), { mode: 0o600 });
  const summary = emptySummary();
  let reads = 0;
  const mutate = async (...args) => {
    const record = await readFileRecord(...args);
    reads += 1;
    await fs.appendFile(filename, encode([row("invocation_start")]));
    return record;
  };
  assert.equal(await readTelemetry(filename, summary, mutate), null);
  assert.equal(reads, 3);
  assert.equal(summary.unstable_files, 1);
  assert.equal(summary.files_found, 0);
  const stable = emptySummary();
  assert.ok(await readTelemetry(filename, stable));
  assert.equal(stable.files_found, 1);
});
