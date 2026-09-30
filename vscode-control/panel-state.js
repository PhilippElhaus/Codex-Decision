"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { validateSessionPath } = require("./core");

const FILTERS = new Set(["output", "test_build", "search_listing"]);
function probability(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invalid Jev panel probability");
  }
  return value;
}

// A visual retention index, not a Jev probability. The action separates kept
// and omitted lines; the original Noul values determine position within each band.
function retentionIndex(row) {
  const omissionResistance = 1 - row.can_omit;
  if (row.action === "omit") return 0.35 * omissionResistance;
  const keepEvidence = Math.max(omissionResistance, row.exact_needed,
    row.task_relevant ?? 0);
  return 0.65 + 0.35 * keepEvidence;
}

function parsePanelDecision(value) {
  if (!value || value.version !== 3) throw new Error("Unsupported Jev panel decision");
  return parseBatchDecision(value);
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
      task_relevant: row.task_relevant ?? null, retention_index: retentionIndex(row) };
  });
  return { version: 3, id: value.id, receipt_id: value.receipt_id, at: value.at,
    filter: value.filter, status: value.status, batch: { number: batch.number, count: batch.count,
      target_count: batch.target_count }, rows, totals, batch_elapsed_ms: value.batch_elapsed_ms };
}

async function readLatestPanelDecision(directory) {
  const filename = path.join(directory, "logs", "latest-decision.json");
  let file;
  try {
    await validateSessionPath(directory);
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 256 * 1024) {
      throw new Error("Unsafe Jev panel decision file");
    }
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > 256 * 1024) throw new Error("Unsafe Jev panel decision file");
    const value = JSON.parse(await file.readFile("utf8"));
    return parsePanelDecision(value);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}

module.exports = { parsePanelDecision, readLatestPanelDecision };
