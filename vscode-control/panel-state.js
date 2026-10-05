"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { validateSessionPath, validateDirectoryPath, readHookHealth, readConfig, readLifetimeStats } = require("./core");

const FILTERS = new Set(["output", "test_build", "search_listing"]);
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
function probability(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invalid Jev panel probability");
  }
  return value;
}

// A visual retention index, not a Jev probability. The action separates kept
// and omitted lines; the original Noul values determine position within each band.
function retentionIndex(row) {
  if (row.can_omit == null) return row.task_relevant ?? null;
  const omissionResistance = 1 - row.can_omit;
  if (row.action === "omit") return 0.35 * omissionResistance;
  const keepEvidence = Math.max(omissionResistance, row.exact_needed,
    row.task_relevant ?? 0);
  return 0.65 + 0.35 * keepEvidence;
}

function parsePanelDecision(value) {
  if (!value || ![3, 4, 5, 6].includes(value.version)) throw new Error("Unsupported Jev panel decision");
  return parseBatchDecision(value);
}

function parseBatchDecision(value) {
  const identifier = /^[a-f0-9]{32}$/;
  const integer = (number, limit = 2_000_000) => Number.isSafeInteger(number) && number >= 0 && number <= limit;
  const reasons = new Set(["protected", "budget_unjudged", "below_omit_cutoff", "exact_text",
    "task_relevant", "irrelevant", "confident_omission", "representative", "last_line"]);
  const totals = value.totals;
  const batch = value.batch;
  const completeRows = value.version >= 5;
  const classificationRequests = value.version >= 6 ? totals?.classification_requests : value.version >= 4 ? 1 : 0;
  if (!identifier.test(value.id) || !identifier.test(value.receipt_id) ||
      typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      !FILTERS.has(value.filter) || !new Set(["processing", "keep", "candidate", "replace"]).has(value.status) ||
      !batch || (value.version >= 4 && value.filter !== "output") || !integer(batch.number) || batch.number < 1 ||
      !integer(batch.count) || batch.count < batch.number ||
      !integer(batch.target_count, value.version >= 4 ? 10_000 : 250) || batch.target_count < 1 ||
      !Array.isArray(value.rows) || (!completeRows && value.rows.length !== batch.target_count) ||
      !totals || ["seen", "judged", "kept", "omitted", "protected", "unjudged", "requests"]
        .some((name) => !integer(totals[name])) ||
      (completeRows ? value.rows.length !== totals.seen || !integer(totals.seen, 10_000) : totals.judged < value.rows.length) ||
      totals.judged > totals.seen || batch.target_count > totals.judged ||
      totals.protected > totals.seen || totals.unjudged > totals.seen ||
      totals.omitted > totals.judged || totals.kept + totals.omitted !== totals.seen ||
      !integer(classificationRequests, 1) || totals.requests !== batch.number + classificationRequests || !integer(value.batch_elapsed_ms, 3_600_000)) {
    throw new Error("Invalid Jev batch decision");
  }
  let previousLine = 0;
  const rows = value.rows.map((row, index) => {
    const unscored = completeRows && row?.task_relevant == null;
    if (!row || !integer(row.line) || row.line <= previousLine || row.line > totals.seen ||
        typeof row.excerpt !== "string" || row.excerpt.length > 120 ||
        !["keep", "omit"].includes(row.action) || !reasons.has(row.reason) ||
        (value.version === 3 && (typeof row.can_omit !== "number" || typeof row.exact_needed !== "number")) ||
        (value.version >= 4 && (row.can_omit != null || row.exact_needed != null || (!unscored && typeof row.task_relevant !== "number"))) ||
        (completeRows && row.line !== index + 1) ||
        (unscored && (row.action !== "keep" || !["protected", "budget_unjudged"].includes(row.reason))) ||
        (row.protected_reason != null && (typeof row.protected_reason !== "string" ||
          !/^[a-z0-9_]{1,80}$/.test(row.protected_reason) || row.action !== "keep" ||
          !["protected", "representative", "last_line"].includes(row.reason))) ||
        (row.task_relevant != null && typeof row.task_relevant !== "number")) {
      throw new Error("Invalid Jev batch row");
    }
    previousLine = row.line;
    if (value.version === 3) { probability(row.can_omit); probability(row.exact_needed); }
    if (row.task_relevant != null) probability(row.task_relevant);
    return { line: row.line, excerpt: row.excerpt, action: row.action, reason: row.reason,
      can_omit: row.can_omit ?? null, exact_needed: row.exact_needed ?? null,
      task_relevant: row.task_relevant ?? null, retention_index: retentionIndex(row),
      protected_reason: row.protected_reason ?? null };
  });
  if (completeRows && (rows.filter(row => row.task_relevant !== null).length !== totals.judged ||
      rows.filter(row => row.action === "omit").length !== totals.omitted ||
      rows.filter(row => row.protected_reason !== null).length !== totals.protected ||
      rows.filter(row => row.reason === "budget_unjudged").length !== totals.unjudged)) {
    throw new Error("Jev panel rows do not match totals");
  }
  return { version: value.version, id: value.id, receipt_id: value.receipt_id, at: value.at,
    filter: value.filter, status: value.status, batch: { number: batch.number, count: batch.count,
      target_count: batch.target_count }, rows, totals, batch_elapsed_ms: value.batch_elapsed_ms };
}

async function readLatestPanelDecision(directory, cache = null) {
  const filename = path.join(directory, "logs", "latest-decision.json");
  let file;
  try {
    await validateSessionPath(directory);
    await validateDirectoryPath(path.dirname(filename));
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_SNAPSHOT_BYTES) {
      throw new Error("Unsafe Jev panel decision file");
    }
    const fingerprint = `${filename}:${details.dev}:${details.ino}:${details.mtimeMs}:${details.ctimeMs}:${details.size}`;
    if (cache?.fingerprint === fingerprint) return cache.value;
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > MAX_SNAPSHOT_BYTES) throw new Error("Unsafe Jev panel decision file");
    // The writer can replace or grow the file after stat. Bound the read itself.
    const bytes = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_SNAPSHOT_BYTES) throw new Error("Unsafe Jev panel decision file");
    const value = JSON.parse(bytes.toString("utf8", 0, length));
    const parsed = parsePanelDecision(value);
    if (cache) { cache.fingerprint = fingerprint; cache.value = parsed; }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") { if (cache) cache.fingerprint = null; return null; }
    throw error;
  } finally {
    await file?.close();
  }
}

async function readPanelActivity(directory) {
  const [health, config, stats] = await Promise.all([
    readHookHealth(directory), readConfig(directory), readLifetimeStats(directory),
  ]);
  let message;
  if (!config.enabled) message = "Jev is off for this thread.";
  else if (!health) message = "Waiting for tool output. If activity stays absent, check /hooks and start a new Codex thread.";
  else if (health.last_error_ms >= Math.max(health.last_skip_ms || 0, health.last_success_ms || 0)) {
    message = `Hook error: ${health.last_error}. Full output was kept.`;
  } else if (health.last_skip_ms >= (health.last_success_ms || 0)) {
    const reasons = {
      choice_kept_full_output: "Jev classified the output and kept it complete. No line judgments were needed.",
      unsupported_route: "The hook skipped this tool or command format before calling Jev.",
      unsupported_result: "The hook kept this response format complete.",
      small: "The latest output was too short to evaluate.",
      sensitive: "The latest output was protected from sending to Jev.",
      unsafe_task_context: "The task context was protected from sending to Jev.",
      exact_content: "The latest result requires exact source content and was kept complete.",
      exhaustive_task: "The task requires the complete result, so it was kept without an API request.",
      structure_guard: "The latest result has no validated independent-line format and was kept complete.",
      insufficient_savings: "The latest result could not save enough text after preserving evidence and metadata.",
    };
    message = reasons[health.last_skip] || `Hook ran; latest output skipped: ${health.last_skip.replaceAll("_", " ")}.`;
  } else message = "Waiting for the next line decision.";
  return { message, calls: stats.calls, skipped: health?.skipped || 0 };
}

module.exports = { parsePanelDecision, readLatestPanelDecision, readPanelActivity };
