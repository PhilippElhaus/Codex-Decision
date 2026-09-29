"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");

const CHOICES = { filter_decision: ["filter", "keep"] };
for (let index = 0; index < 12; index += 1) CHOICES[`group_${index}`] = ["retain", "summarize", "drop"];
const CHECKS = new Set(["routine_noise", "needs_exact_text", "one_off_value"]);
const FILTERS = new Set(["output", "test_build", "search_listing"]);
const STATUSES = new Set(["keep", "replace", "candidate", "skip"]);
const THEMES = new Set(["output_filter", "output_keep", "output_noul", "output_evaluated",
  "build_filter", "build_keep", "build_noul", "build_evaluated",
  "search_retain", "search_summarize", "search_drop", "search_mixed", "search_evaluated"]);

function probability(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invalid Jev panel probability");
  }
  return value;
}

function parseRecent(value, latestId) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 5 ||
      value.at(-1)?.id !== latestId) throw new Error("Invalid Jev panel history");
  const ids = new Set();
  return value.map((row) => {
    if (!row || !/^[a-f0-9]{32}$/.test(row.id) || !THEMES.has(row.theme) ||
        !Number.isInteger(row.elapsed_ms) || row.elapsed_ms < 0 || row.elapsed_ms > 3_600_000 ||
        ids.has(row.id)) throw new Error("Invalid Jev panel history");
    ids.add(row.id);
    return { id: row.id, theme: row.theme, elapsed_ms: row.elapsed_ms };
  });
}

function parsePanelDecision(value) {
  if (value?.version === 3) return parseBatchDecision(value);
  if (value?.version === 2) return parseLineDecision(value);
  if (!value || value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.id) ||
      typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      !FILTERS.has(value.filter) || !STATUSES.has(value.status) ||
      !Number.isInteger(value.call_index) || !Number.isInteger(value.call_count) ||
      value.call_index < 1 || value.call_count < value.call_index || value.call_count > 1000 ||
      !Array.isArray(value.choices) || value.choices.length > 12 ||
      !Array.isArray(value.checks) || value.checks.length > 3 ||
      (value.demo !== undefined && typeof value.demo !== "boolean")) {
    throw new Error("Invalid Jev panel decision");
  }
  const choices = value.choices.map((row) => {
    const options = CHOICES[row?.name];
    if (!options || !options.includes(row.selected) || !row.probabilities ||
        Object.keys(row.probabilities).length !== options.length ||
        options.some((option) => !Object.hasOwn(row.probabilities, option))) {
      throw new Error("Invalid Jev panel choice");
    }
    const probabilities = Object.fromEntries(options.map((option) => [option, probability(row.probabilities[option])]));
    const sum = Object.values(probabilities).reduce((total, number) => total + number, 0);
    if (sum < 0.97 || sum > 1.03) throw new Error("Invalid Jev panel choice");
    return { name: row.name, selected: row.selected, probabilities };
  });
  const checks = value.checks.map((row) => {
    if (!CHECKS.has(row?.name)) throw new Error("Invalid Jev panel check");
    return { name: row.name, probability: probability(row.probability) };
  });
  return { id: value.id, at: value.at, filter: value.filter, status: value.status,
    call_index: value.call_index, call_count: value.call_count, choices, checks,
    recent: parseRecent(value.recent, value.id), demo: value.demo === true };
}

function parseBatchDecision(value) {
  const identifier = /^[a-f0-9]{32}$/;
  const integer = (number, limit = 2_000_000) => Number.isSafeInteger(number) && number >= 0 && number <= limit;
  const reasons = new Set(["protected", "budget_unjudged", "below_omit_cutoff", "exact_text",
    "task_relevant", "confident_omission", "representative", "last_line"]);
  const totals = value.totals;
  const batch = value.batch;
  if (!identifier.test(value.id) || !identifier.test(value.receipt_id) ||
      typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      !FILTERS.has(value.filter) || !new Set(["processing", "keep", "candidate", "replace"]).has(value.status) ||
      !batch || !integer(batch.number) || batch.number < 1 ||
      !integer(batch.count) || batch.count < batch.number ||
      !integer(batch.target_count, 250) || batch.target_count < 1 ||
      !Array.isArray(value.rows) || value.rows.length !== batch.target_count ||
      !totals || ["seen", "judged", "kept", "omitted", "protected", "unjudged", "requests"]
        .some((name) => !integer(totals[name])) ||
      totals.judged < value.rows.length || totals.judged > totals.seen ||
      totals.omitted > totals.judged || totals.kept + totals.omitted !== totals.seen ||
      totals.requests !== batch.number || !integer(value.batch_elapsed_ms, 3_600_000)) {
    throw new Error("Invalid Jev batch decision");
  }
  let previousLine = 0;
  const rows = value.rows.map((row) => {
    if (!row || !integer(row.line) || row.line <= previousLine ||
        typeof row.excerpt !== "string" || row.excerpt.length > 120 ||
        !["keep", "omit"].includes(row.action) || !reasons.has(row.reason) ||
        typeof row.can_omit !== "number" || typeof row.exact_needed !== "number" ||
        (row.task_relevant != null && typeof row.task_relevant !== "number")) {
      throw new Error("Invalid Jev batch row");
    }
    previousLine = row.line;
    probability(row.can_omit);
    probability(row.exact_needed);
    if (row.task_relevant != null) probability(row.task_relevant);
    return { line: row.line, excerpt: row.excerpt, action: row.action, reason: row.reason,
      can_omit: row.can_omit, exact_needed: row.exact_needed,
      task_relevant: row.task_relevant ?? null };
  });
  return { version: 3, id: value.id, receipt_id: value.receipt_id, at: value.at,
    filter: value.filter, status: value.status, batch: { number: batch.number, count: batch.count,
      target_count: batch.target_count }, rows, totals, batch_elapsed_ms: value.batch_elapsed_ms };
}

function parseLineDecision(value) {
  const identifier = /^[a-f0-9]{32}$/;
  const lineIdentifier = /^[a-f0-9]{32}-\d+$/;
  const actions = new Set(["keep", "omit", "keep_unjudged"]);
  const reasons = new Set(["protected", "budget_unjudged", "below_omit_cutoff", "exact_text",
    "task_relevant", "confident_omission", "representative", "last_line"]);
  const integer = (number, limit = 2_000_000) => Number.isSafeInteger(number) && number >= 0 && number <= limit;
  if (!identifier.test(value.id) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      !FILTERS.has(value.filter) || !new Set(["processing", "keep", "candidate", "replace"]).has(value.status) ||
      !value.totals || !Object.values(value.totals).every((number) => integer(number)) ||
      !Array.isArray(value.recent) || value.recent.length > 5 ||
      (value.batch_elapsed_ms !== null && !integer(value.batch_elapsed_ms, 3_600_000))) {
    throw new Error("Invalid Jev line decision");
  }
  const parseLine = (row) => {
    if (!row || !lineIdentifier.test(row.id) || !integer(row.line) || row.line < 1 ||
        typeof row.excerpt !== "string" || row.excerpt.length > 240 ||
        typeof row.summary !== "string" || row.summary.length > 120 || !actions.has(row.action) ||
        !Number.isFinite(row.can_omit) || row.can_omit < 0 || row.can_omit > 1 ||
        !Number.isFinite(row.exact_needed) || row.exact_needed < 0 || row.exact_needed > 1 ||
        (row.task_relevant != null && (typeof row.task_relevant !== "number" ||
          !Number.isFinite(row.task_relevant) || row.task_relevant < 0 || row.task_relevant > 1)) ||
        (row.reason !== undefined && !reasons.has(row.reason))) {
      throw new Error("Invalid Jev line row");
    }
    return { id: row.id, line: row.line, excerpt: row.excerpt, summary: row.summary,
      action: row.action, reason: row.reason ?? null, can_omit: row.can_omit,
      exact_needed: row.exact_needed, task_relevant: row.task_relevant ?? null };
  };
  const recent = value.recent.map(parseLine);
  const latest = parseLine(value.latest);
  if (recent.at(-1)?.id !== latest.id || new Set(recent.map((row) => row.id)).size !== recent.length ||
      value.totals.judged > value.totals.seen || value.totals.omitted > value.totals.judged ||
      value.totals.kept + value.totals.omitted !== value.totals.seen) {
    throw new Error("Inconsistent Jev line decision");
  }
  return { version: 2, id: value.id, at: value.at, filter: value.filter, status: value.status,
    latest, recent, totals: value.totals, batch_elapsed_ms: value.batch_elapsed_ms };
}

async function readLatestPanelDecision(directory) {
  const filename = path.join(directory, "logs", "latest-decision.json");
  let file;
  try {
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 256 * 1024) {
      throw new Error("Unsafe Jev panel decision file");
    }
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > 256 * 1024) throw new Error("Unsafe Jev panel decision file");
    const value = JSON.parse(await file.readFile("utf8"));
    return value.version === 2 || value.version === 3 ? parsePanelDecision(value) : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}

module.exports = { parsePanelDecision, readLatestPanelDecision };
