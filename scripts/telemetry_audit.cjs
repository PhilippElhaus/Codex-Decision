#!/usr/bin/env node
"use strict";

// Offline, metadata-only audit. Never read credentials, receipts, or raw output.
const fs = require("node:fs/promises");
const path = require("node:path");
const { readFileRecord, parseUnsignedJson, validateDirectoryPath, validateSessionPath } = require("../vscode-control/private-records");

const LIMIT = 4 * 1024 * 1024;
const FAMILIES = ["shell", "code_mode", "native_lab", "other_mcp", "other"];
const PROVIDERS = ["openai", "typesafe", "custom"];
const OUTCOMES = ["skip", "replace", "candidate", "keep", "error"];
const REQUEST_OUTCOMES = ["validated", "invalid_response", "transport_error", "http_error", "cancelled", "local_error"];
const ERRORS = ["hook_deadline", "missing_credential", "request_failed", "response_read_failed", "response_too_large",
  "invalid_json", "request_budget", "log_lock_timeout", "local_or_validation_error"];
const COUNTS = new Set(["version", "request_index", "elapsed_ms", "request_bytes", "response_bytes", "http_status",
  "input_tokens", "output_tokens", "source_bytes", "source_chars", "source_lines", "request_count", "lines_judged",
  "proposed_omitted", "prepared_saved_chars", "min_chars", "max_chars", "lines_relevance_below_cutoff",
  "lines_restored_by_guards", "prepared_omitted_lines"]);
const countPath = keys => keys.length === 1 && COUNTS.has(keys[0]);
const REASONS = ["unsupported_event", "unsupported_route", "unsupported_result", "small", "large", "tool_input_budget",
  "line_budget", "exact_content", "sensitive", "structured_or_empty", "no_eligible_lines", "structure_guard",
  "mcp_replacement_disabled", "unsafe_task_context", "exhaustive_task", "insufficient_savings", "relevance_budget",
  "choice_kept_full_output", "relevance_policy", "no_omissions", "observe", "missing_task_context", "unsupported_command",
  "unsupported_envelope", "filtered", "local_error", "provider_error", "unknown", ...ERRORS];
const safe = (value, allowed) => allowed.includes(value) ? value : "unrecorded";
const uint = value => Number.isSafeInteger(value) && value >= 0;
function add(map, key, amount = 1) {
  const next = (map[key] || 0) + amount;
  if (!uint(next)) throw new Error("Telemetry count exceeds exact numeric range");
  map[key] = next;
}
function distribution() { return { count: 0, sum_ms: 0, max_ms: null, buckets: {} }; }
function observe(metric, value) {
  if (!uint(value)) return;
  add(metric, "count"); add(metric, "sum_ms", value);
  metric.max_ms = Math.max(metric.max_ms || 0, value);
  // Fixed logarithmic bins bound memory. Quantiles are upper bounds, not exact samples.
  add(metric.buckets, value === 0 ? "0" : String(2 ** Math.ceil(Math.log2(value))));
}
function finish(metric) {
  const quantile = fraction => {
    let count = 0;
    for (const [upper, amount] of Object.entries(metric.buckets).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      count += amount;
      if (count >= Math.ceil(metric.count * fraction)) return Number(upper);
    }
    return null;
  };
  return { ...metric, mean_ms: metric.count ? metric.sum_ms / metric.count : null,
    p50_upper_ms: quantile(0.5), p95_upper_ms: quantile(0.95), p99_upper_ms: quantile(0.99) };
}
function emptySummary() {
  return { schema_version: 1, scopes_scanned: 0, files_found: 0, unstable_files: 0, tail_limited_files: 0, incomplete_final_rows: 0,
    malformed_rows: 0, unsupported_rows: 0, rows_outside_window: 0, records: 0,
    first_at: null, last_at: null, runtime: {}, hook_versions: {}, tools: {}, outcomes: {}, reasons: {},
    configured_providers: {}, modes: {}, relevance_cutoffs: {}, source_size_bands: {}, request_providers: {},
    request_stages: {}, request_outcomes: {}, request_errors: {}, http_statuses: {},
    starts: 0, completions: 0, requests: 0, outputs_with_requests: 0, fallback_invocations: 0,
    completions_without_start: 0, starts_without_completion: 0, requests_without_completion: 0, duplicate_records: 0,
    completions_with_missing_request_rows: 0, request_rows_missing_at_least: 0, request_rows_exceeding_completion_count: 0,
    request_bytes: 0, response_bytes: 0, reported_input_tokens: 0, reported_output_tokens: 0,
    usage_records: 0, measured_fields: {}, source_bytes: 0, prepared_saved_chars: 0, proposed_omitted_lines: 0,
    lines_relevance_below_cutoff: 0, lines_restored_by_guards: 0, prepared_omitted_lines: 0,
    invocation_latency: distribution(), request_latency: distribution(), request_latency_by_stage: {}, request_latency_by_outcome: {},
    delivery: "unverified", limits: ["Best-effort retained metadata; missing records are unknown, not zero.",
      "Time filters apply to individual rows. Tail retention, contention, crashes, and window boundaries can separate related records.",
      "Latency percentiles are logarithmic bucket upper bounds. Invocation timing starts after enabled configuration is selected.",
      "Prepared payload savings do not establish delivered context, billed token savings, or evidence quality."] };
}

function consume(text, summary, since = -Infinity) {
  const invocations = new Map(), records = new Set();
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline;
    const line = bytes.subarray(start, end); start = end + 1;
    if (!line.length) continue;
    let row;
    try {
      if (line.length > 8192) throw new Error();
      row = parseUnsignedJson(line, countPath, countPath);
      if (row && Object.entries(row).some(([key, value]) => COUNTS.has(key) && value !== null && !uint(value))) throw new Error();
    }
    catch { add(summary, "malformed_rows"); continue; }
    if (!row || row.version !== 1 || !["invocation_start", "request", "invocation"].includes(row.event)) {
      add(summary, "unsupported_rows"); continue;
    }
    const time = typeof row.at === "string" && /^\d{4}-\d\d-\d\dT/.test(row.at) ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(time) || !/^[a-f0-9]{32}$/.test(row.invocation_id || "") ||
        row.event === "request" && (!uint(row.request_index) || row.request_index === 0)) {
      add(summary, "malformed_rows"); continue;
    }
    if (time < since) { add(summary, "rows_outside_window"); continue; }
    const key = `${row.invocation_id}:${row.event}:${row.event === "request" ? row.request_index : ""}`;
    if (records.has(key)) { add(summary, "duplicate_records"); continue; }
    records.add(key);
    const state = invocations.get(row.invocation_id) || { start: false, completion: false, requests: 0, expected: null };
    invocations.set(row.invocation_id, state);
    add(summary, "records");
    const at = new Date(time).toISOString();
    if (!summary.first_at || at < summary.first_at) summary.first_at = at;
    if (!summary.last_at || at > summary.last_at) summary.last_at = at;
    add(summary.runtime, safe(row.runtime, ["linux", "windows", "macos"]));
    add(summary.hook_versions, typeof row.hook_version === "string" && row.hook_version.length <= 32 && /^\d+\.\d+\.\d+$/.test(row.hook_version) ? row.hook_version : "unrecorded");
    if (row.event === "invocation_start") {
      state.start = true; add(summary, "starts");
      add(summary.tools, safe(row.tool_family, FAMILIES));
      add(summary.configured_providers, safe(row.provider, PROVIDERS));
      add(summary.modes, safe(row.mode, ["replace", "observe"]));
      add(summary.relevance_cutoffs, uint(row.relevance_max) && row.relevance_max <= 100 ? String(row.relevance_max) : "unrecorded");
    } else if (row.event === "request") {
      state.requests += 1; add(summary, "requests");
      add(summary.request_providers, safe(row.provider, PROVIDERS));
      const stage = safe(row.stage, ["classification", "relevance"]);
      const outcome = safe(row.outcome, REQUEST_OUTCOMES);
      add(summary.request_stages, stage); add(summary.request_outcomes, outcome);
      if (row.error_code !== null && row.error_code !== undefined) add(summary.request_errors, safe(row.error_code, ERRORS));
      add(summary.http_statuses, Number.isInteger(row.http_status) && row.http_status >= 100 && row.http_status <= 599 ? String(row.http_status) : "unrecorded");
      observe(summary.request_latency, row.elapsed_ms);
      observe(summary.request_latency_by_stage[stage] ||= distribution(), row.elapsed_ms);
      observe(summary.request_latency_by_outcome[outcome] ||= distribution(), row.elapsed_ms);
      for (const name of ["request_bytes", "response_bytes"]) if (uint(row[name])) {
        add(summary, name, row[name]); add(summary.measured_fields, name);
      }
      if (uint(row.input_tokens) && uint(row.output_tokens)) {
        add(summary, "usage_records"); add(summary, "reported_input_tokens", row.input_tokens); add(summary, "reported_output_tokens", row.output_tokens);
      }
    } else {
      state.completion = true; add(summary, "completions");
      state.expected = uint(row.request_count) ? row.request_count : null;
      add(summary.outcomes, safe(row.outcome, OUTCOMES)); add(summary.reasons, safe(row.reason, REASONS));
      observe(summary.invocation_latency, row.elapsed_ms);
      if (row.fallback_used === true) add(summary, "fallback_invocations");
      if (uint(row.request_count) && row.request_count > 0) add(summary, "outputs_with_requests");
      for (const name of ["source_bytes", "prepared_saved_chars", "lines_relevance_below_cutoff",
        "lines_restored_by_guards", "prepared_omitted_lines"]) if (uint(row[name])) {
        add(summary, name, row[name]); add(summary.measured_fields, name);
      }
      if (uint(row.proposed_omitted)) {
        add(summary, "proposed_omitted_lines", row.proposed_omitted); add(summary.measured_fields, "proposed_omitted_lines");
      }
      const size = row.source_bytes;
      add(summary.source_size_bands, !uint(size) ? "unrecorded" : size < 256 ? "under_256" : size < 1024 ? "256_1023" :
        size < 4096 ? "1024_4095" : size < 16384 ? "4096_16383" : "16384_plus");
    }
  }
  for (const state of invocations.values()) {
    if (state.start && !state.completion) add(summary, "starts_without_completion");
    if (state.completion && !state.start) add(summary, "completions_without_start");
    if (!state.completion) add(summary, "requests_without_completion", state.requests);
    if (state.expected !== null && state.expected > state.requests) {
      add(summary, "completions_with_missing_request_rows");
      add(summary, "request_rows_missing_at_least", state.expected - state.requests);
    }
    if (state.expected !== null && state.requests > state.expected) add(summary, "request_rows_exceeding_completion_count", state.requests - state.expected);
  }
}

const fingerprint = (filename, details) => `${filename}:${details.dev}:${details.ino}:${details.mtimeMs}:${details.ctimeMs}:${details.size}`;
async function readTelemetry(filename, summary, reader = readFileRecord) {
  // The writer compacts in place. Accept only a read with stable metadata;
  // continuous writers produce an explicit gap instead of a mixed snapshot.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let details;
    try { details = await fs.lstat(filename); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const start = Math.max(0, details.size - LIMIT);
    const record = await reader(filename, LIMIT, { strict: true, range: { position: start, length: details.size - start } });
    if (!record) continue;
    let after;
    try { after = await fs.lstat(filename); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (fingerprint(filename, details) !== record.fingerprint || record.fingerprint !== fingerprint(filename, after)) continue;
    add(summary, "files_found");
    let bytes = record.bytes;
    if (start) { add(summary, "tail_limited_files"); bytes = bytes.subarray(bytes.indexOf(10) + 1); }
    if (bytes.length && bytes.at(-1) !== 10) {
      add(summary, "incomplete_final_rows"); bytes = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
    }
    return bytes;
  }
  add(summary, "unstable_files");
  return null;
}

async function audit(dataDir, { since = null } = {}) {
  if (!path.isAbsolute(dataDir)) throw new Error("Use an absolute Decision data directory");
  const boundary = since === null ? -Infinity : Date.parse(since);
  if (since !== null && (typeof since !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(since) || !Number.isFinite(boundary))) {
    throw new Error("Use a UTC ISO timestamp for --since");
  }
  await validateDirectoryPath(dataDir);
  const scopes = [dataDir], sessions = path.join(dataDir, "sessions");
  await validateDirectoryPath(sessions);
  let entries;
  try { entries = await fs.readdir(sessions, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; entries = []; }
  for (const entry of entries) if (/^[a-f0-9]{64}$/.test(entry.name)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe telemetry session directory");
    scopes.push(path.join(sessions, entry.name));
    if (scopes.length > 4097) throw new Error("Telemetry session scan limit exceeded");
  }
  const summary = emptySummary();
  for (const scope of scopes) {
    await validateSessionPath(scope); await validateDirectoryPath(path.join(scope, "logs"));
    add(summary, "scopes_scanned");
    const bytes = await readTelemetry(path.join(scope, "logs/telemetry.jsonl"), summary);
    if (bytes) consume(bytes, summary, boundary);
  }
  summary.invocation_latency = finish(summary.invocation_latency);
  summary.request_latency = finish(summary.request_latency);
  for (const [stage, metric] of Object.entries(summary.request_latency_by_stage)) summary.request_latency_by_stage[stage] = finish(metric);
  for (const [outcome, metric] of Object.entries(summary.request_latency_by_outcome)) summary.request_latency_by_outcome[outcome] = finish(metric);
  return { ...summary, since };
}

if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  let valid = true;
  for (let index = 0; index < args.length; index += 2) {
    if (!["--data-dir", "--since"].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) { valid = false; break; }
    options[args[index]] = args[index + 1];
  }
  if (!valid || !options["--data-dir"]) {
    process.stderr.write("Usage: node scripts/telemetry_audit.cjs --data-dir <absolute-PLUGIN_DATA> [--since <UTC-ISO-timestamp>]\n"); process.exitCode = 1;
  } else audit(options["--data-dir"], { since: options["--since"] || null }).then(result => process.stdout.write(JSON.stringify(result, null, 2) + "\n")).catch(() => {
    process.stderr.write("Telemetry audit failed: invalid arguments or unsafe/unreadable metadata.\n"); process.exitCode = 1;
  });
}
module.exports = { audit, consume, emptySummary, finish, readTelemetry };
