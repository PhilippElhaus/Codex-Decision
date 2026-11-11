"use strict";

const path = require("node:path");
const { readFileRecord, parseUniqueJson, validateSessionPath } = require("./private-records");
const LIMIT = 4 * 1024 * 1024;
const uint = n => Number.isSafeInteger(n) && n >= 0;

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
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  const lines = text.split("\n");
  if (lines.pop()) gaps.incomplete_rows++;
  return lines.flatMap(line => {
    try {
      const row = parseUniqueJson(line);
      if (row.version !== 1 || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) throw new Error();
      return [row];
    } catch { gaps.invalid_rows++; return []; }
  });
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

function summarize(observations, requests = [], gaps = { missing_files: 0, invalid_rows: 0, incomplete_rows: 0, inexact_totals: 0 }) {
  const turns = new Map(), modes = { observe: bucket(), replace: bucket(), unattributed: bucket() };
  const report = { version: 1, scope: "retained active-session observations", gaps, modes,
    first_at: null, last_at: null,
    decision: { requests: 0, usage_records: 0, missing_usage: 0, input_tokens: 0, output_tokens: 0,
      cached_tokens: 0, cache_usage_records: 0, cache_write_tokens: 0, cache_write_records: 0 },
    delivery: "unverified", causal_savings: null, estimated_cost_usd: null,
    interpretation: "Monitor/Filter differences are observational. Prepared replacements do not prove reduced delivered context, task quality, or billed cost. Missing usage is unknown, never zero." };
  for (const row of observations) {
    if (typeof row.at === "string" && Number.isFinite(Date.parse(row.at))) {
      if (report.first_at === null || Date.parse(row.at) < Date.parse(report.first_at)) report.first_at = row.at;
      if (report.last_at === null || Date.parse(row.at) > Date.parse(report.last_at)) report.last_at = row.at;
    }
    if (!["model_request_start", "model_request", "tool_output", "completion_review"].includes(row.event)) continue;
    const key = typeof row.turn_key === "string" && /^[a-f0-9]{64}$/.test(row.turn_key) ? row.turn_key : null;
    if (!key) { if (row.event === "model_request") record(modes.unattributed, row); continue; }
    if (!turns.has(key)) turns.set(key, { modes: new Set(), outputs: 0, models: [] });
    const turn = turns.get(key);
    if (["observe", "replace"].includes(row.mode)) turn.modes.add(row.mode); else turn.modes.add("unknown");
    if (row.event === "tool_output" && row.prepared_replacement === true) turn.outputs++;
    if (row.event === "model_request") turn.models.push(row);
  }
  function record(target, row) {
    if (!["completed", "failed", "cancelled"].includes(row.status)) { gaps.invalid_rows++; return; }
    target.attempts++; target[row.status]++;
    usage(target, row.usage, gaps);
  }
  for (const turn of turns.values()) {
    if (!turn.models.length) continue;
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
    if (!value.usage_records && (value.attempts || value.requests)) { value.input_tokens = null; value.output_tokens = null; }
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
  const gaps = { missing_files: 0, unstable_files: 0, invalid_rows: 0, incomplete_rows: 0, inexact_totals: 0 };
  const observations = await rows(directory, "model-requests.jsonl", gaps);
  const requests = await rows(directory, "telemetry.jsonl", gaps);
  const assistant = await rows(path.join(directory, "assistance"), "model-requests.jsonl", gaps);
  return summarize(observations, [...requests, ...assistant], gaps);
}

module.exports = { readDeliveryReport, summarize };
