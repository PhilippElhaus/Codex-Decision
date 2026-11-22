"use strict";

const path = require("node:path");
const { readFileRecord, parseUnsignedJson, validateSessionPath } = require("./private-records");
const LIMIT = 4 * 1024 * 1024;
const uint = n => Number.isSafeInteger(n) && n >= 0;
const TERMINAL = ["completed", "failed", "cancelled"];
const COUNTS = new Set(["input_tokens", "output_tokens", "cached_tokens", "cache_write_tokens"]);
const countPath = keys => keys.length === 1 && (keys[0] === "version" || COUNTS.has(keys[0])) ||
  keys.length === 2 && keys[0] === "usage" && COUNTS.has(keys[1]);
const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const emptyGaps = () => ({ missing_files: 0, unstable_files: 0, invalid_rows: 0, incomplete_rows: 0, inexact_totals: 0,
  uncorrelated_model_starts: 0, model_starts_without_terminal_at_least: 0, model_terminals_without_start_at_least: 0 });

async function rows(directory, name, gaps) {
  await validateSessionPath(directory);
  await validateSessionPath(path.join(directory, "logs"));
  const filename = path.join(directory, "logs", name);
  let file = null, stable = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readFileRecord(filename, LIMIT, { strict: true });
    const after = await readFileRecord(filename, LIMIT, { strict: true });
    if (!before && !after) { stable = true; break; }
    if (before && after && before.fingerprint === after.fingerprint && before.bytes.equals(after.bytes)) {
      file = after; stable = true; break;
    }
  }
  if (!stable) { gaps.unstable_files++; return []; }
  if (!file) { gaps.missing_files++; return []; }
  const result = [];
  let start = 0;
  for (let end; (end = file.bytes.indexOf(10, start)) >= 0; start = end + 1) {
    try {
      const row = parseUnsignedJson(file.bytes.subarray(start, end), countPath);
      if (row?.version !== 1 || !utc(row.at)) throw new Error();
      result.push(row);
    } catch { gaps.invalid_rows++; }
  }
  if (start < file.bytes.length) gaps.incomplete_rows++;
  return result;
}

function bucket() { return { turns: 0, attempts: 0, completed: 0, failed: 0, cancelled: 0,
  usage_records: 0, missing_usage: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
  cache_usage_records: 0, prepared_replacements: 0 }; }

function add(target, name, value, gaps) {
  if (target[name] === null) return;
  if (!uint(value) || !Number.isSafeInteger(target[name] + value)) { target[name] = null; gaps.inexact_totals++; }
  else target[name] += value;
}

function usage(target, value, gaps) {
  if (!value || !uint(value.input_tokens) || !uint(value.output_tokens)) { target.missing_usage++; return; }
  target.usage_records++;
  add(target, "input_tokens", value.input_tokens, gaps); add(target, "output_tokens", value.output_tokens, gaps);
  if (uint(value.cached_tokens) && value.cached_tokens <= value.input_tokens) {
    target.cache_usage_records++; add(target, "cached_tokens", value.cached_tokens, gaps);
  }
}

function summarize(observations, requests = [], gaps = emptyGaps()) {
  const turns = new Map(), modes = { observe: bucket(), replace: bucket(), unattributed: bucket() };
  const report = { version: 1, scope: "retained active-session observations", gaps, modes,
    first_at: null, last_at: null, coverage: "retained_only",
    completion_review: { capture: {}, evidence: {}, continuation: {} },
    decision: { requests: 0, usage_records: 0, missing_usage: 0, input_tokens: 0, output_tokens: 0,
      cached_tokens: 0, cache_usage_records: 0, cache_write_tokens: 0, cache_write_records: 0 },
    delivery: "unverified", causal_savings: null, estimated_cost_usd: null,
    interpretation: "Counts cover retained rows only. Token totals and means cover reported usage only. Prepared replacements do not prove reduced delivered context, task quality, or billed cost." };
  function observe(target, value, allowed) {
    const label = allowed.includes(value) ? value : "unrecorded";
    target[label] = (target[label] || 0) + 1;
  }
  for (const row of observations) {
    const at = utc(row.at);
    if (at) {
      if (report.first_at === null || at < report.first_at) report.first_at = at;
      if (report.last_at === null || at > report.last_at) report.last_at = at;
    }
    if (!["model_request_start", "model_request", "tool_output", "completion_review"].includes(row.event)) continue;
    if (row.event === "tool_output") observe(report.completion_review.capture, row.completion_capture,
      ["off", "stored", "incomplete", "unbound", "unavailable"]);
    if (row.event === "completion_review") {
      observe(report.completion_review.evidence, row.evidence_coverage, ["observed_window", "incomplete", "unknown"]);
      observe(report.completion_review.continuation, row.continuation_status,
        ["not_requested", "incomplete_evidence", "requested", "evidence_changed", "state_unavailable"]);
    }
    const key = typeof row.turn_key === "string" && /^[a-f0-9]{64}$/.test(row.turn_key) ? row.turn_key : null;
    if (!key) {
      if (row.event === "model_request") record(modes.unattributed, row);
      if (row.event === "model_request_start") gaps.uncorrelated_model_starts++;
      continue;
    }
    if (!turns.has(key)) turns.set(key, { modes: new Set(), outputs: 0, starts: 0, models: [] });
    const turn = turns.get(key);
    if (["observe", "replace"].includes(row.mode)) turn.modes.add(row.mode); else turn.modes.add("unknown");
    if (row.event === "tool_output" && row.prepared_replacement === true) turn.outputs++;
    if (row.event === "model_request_start") turn.starts++;
    if (row.event === "model_request") turn.models.push(row);
  }
  function record(target, row) {
    if (!TERMINAL.includes(row.status)) { gaps.invalid_rows++; return; }
    target.attempts++; target[row.status]++;
    usage(target, row.usage, gaps);
  }
  for (const turn of turns.values()) {
    const terminals = turn.models.filter(row => TERMINAL.includes(row.status)).length;
    gaps.model_starts_without_terminal_at_least += Math.max(0, turn.starts - terminals);
    gaps.model_terminals_without_start_at_least += Math.max(0, terminals - turn.starts);
    if (!terminals) { gaps.invalid_rows += turn.models.length; continue; }
    const mode = turn.modes.size === 1 ? [...turn.modes][0] : "unattributed";
    const target = modes[mode] || modes.unattributed;
    target.turns++; target.prepared_replacements += turn.outputs;
    for (const row of turn.models) record(target, row);
  }
  for (const row of requests) {
    if (row.event !== "request" && row.event !== "assistance_request") continue;
    report.decision.requests++;
    const value = row.event === "request" ? row : row.usage;
    usage(report.decision, value, gaps);
    if (uint(value?.cache_write_tokens) && uint(value?.input_tokens) && value.cache_write_tokens <= value.input_tokens) {
      report.decision.cache_write_records++; add(report.decision, "cache_write_tokens", value.cache_write_tokens, gaps);
    }
  }
  for (const value of [...Object.values(modes), report.decision]) {
    if (!value.usage_records) { value.input_tokens = null; value.output_tokens = null; }
    if (!value.cache_usage_records) value.cached_tokens = null;
  }
  if (!report.decision.cache_write_records) report.decision.cache_write_tokens = null;
  for (const value of Object.values(modes)) value.mean_reported_input_per_attempt =
    value.usage_records && value.input_tokens !== null ? value.input_tokens / value.usage_records : null;
  const a = modes.observe.mean_reported_input_per_attempt, b = modes.replace.mean_reported_input_per_attempt;
  report.observational_input_difference_per_attempt = a !== null && b !== null ? a - b : null;
  return report;
}

async function readDeliveryReport(directory) {
  const gaps = emptyGaps();
  const observations = await rows(directory, "model-requests.jsonl", gaps);
  const requests = await rows(directory, "telemetry.jsonl", gaps);
  const assistant = await rows(path.join(directory, "assistance"), "model-requests.jsonl", gaps);
  return summarize(observations, [...requests, ...assistant], gaps);
}

module.exports = { readDeliveryReport, summarize };
