"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const { restrictWslPath, wslLocation } = require("./private-paths");
const securedWslPaths = new Map();
const { provider, wireRequest, parseHealthResult } = require("./providers");
const { defaults, validate } = require("./schema");
const { validateStatsRecord, STATS_ACTIVITY_KEYS, readFileRecord,
  validateDirectoryPath,validateSessionPath,parseUniqueJson,parseUnsignedJson } = require("./private-records");
const {readPublishedRecord,withPublication} = require("./publication-journal");
const DEFAULT_RELEVANCE_POLICY = Object.freeze(defaults("config").relevance_policy);
const { schema_version: _schemaVersion, ...settingsDefaults } = defaults("settings");
const DEFAULT_SETTINGS = Object.freeze(settingsDefaults);
const HEALTH_ACTIVITY_KEYS = Object.freeze({ seen: "seen", skipped: "skipped", errors: "errors",
  api_requests: "calls", request_cancelled: "requestCancelled", responses_received: "responsesReceived",
  responses_validated: "responsesValidated", request_failures: "requestFailures" });
const LEGACY_PARTIAL_STATS = ["candidates", "kept", "linesActuallyOmitted", "linesRelevanceJudged"];
const REQUEST_OUTCOME_KEYS = ["request_cancelled", "responses_received", "responses_validated", "request_failures"];
function completeRelevancePolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid relevance policy");
  return validate("relevance_threshold", { ...DEFAULT_RELEVANCE_POLICY, ...value });
}

function defaultDataDirectory() {
  return process.env.CODEX_DECISION_DATA_DIRECTORY || "";
}

function sessionDirectory(directory, sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    throw new Error("Decision needs a valid Codex session ID");
  }
  return path.join(directory, "sessions", crypto.createHash("sha256").update(sessionId).digest("hex"));
}

// A directory lock works across extension hosts as well as overlapping controllers.
// A crashed owner's lock fails closed; it is never silently stolen.
async function withWriteLock(directory, operation) {
  await validateSessionPath(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await secureWslDirectories(directory);
  await validateSessionPath(directory);
  const lock = path.join(directory, ".decision-write.lock");
  const deadline = performance.now() + 2000;
  while (true) {
    try { await fs.mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let details;
      try { details = await fs.lstat(lock); }
      catch (statError) { if (statError.code === "ENOENT") continue; throw statError; }
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Unsafe Decision write lock");
      if (performance.now() >= deadline) throw new Error("Decision settings write lock timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await operation(); }
  finally { await fs.rmdir(lock); }
}

async function secureWslDirectories(directory) {
  await validateDirectoryPath(directory);
  const parent = path.dirname(directory);
  const folders = path.basename(parent) === "sessions" ? [path.dirname(parent), parent, directory] : [directory];
  for (const folder of folders) await secureExistingWslPath(folder, true);
}

async function secureExistingWslPath(filename, directory) {
  if (process.platform !== "win32" || !wslLocation(filename)) return;
  const details = await fs.lstat(filename);
  if (details.isSymbolicLink() || (directory ? !details.isDirectory() : !details.isFile())) {
    throw new Error("Unsafe Decision state path");
  }
  const identity = `${details.dev}:${details.ino}:${details.birthtimeMs}:${directory ? "" : `${details.mtimeMs}:${details.size}`}`;
  if (securedWslPaths.get(filename) === identity) return;
  await restrictWslPath(filename, directory);
  if (securedWslPaths.size >= 1024) securedWslPaths.delete(securedWslPaths.keys().next().value);
  securedWslPaths.set(filename, identity);
}

async function atomicWrite(target, content) {
  const temporary = path.join(path.dirname(target), `.jev-${crypto.randomUUID()}.tmp`);
  let owned = false;
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    owned = true;
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await restrictWslPath(temporary, false);
    // Windows readers or scanners can briefly deny replacement. Keep the old
    // file intact and retry the atomic rename for at most 310 ms.
    for (let attempts = 0; ; attempts += 1) {
      try { await fs.rename(temporary, target); break; }
      catch (error) {
        if (process.platform !== "win32" || attempts >= 5 ||
            !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempts));
      }
    }
  } finally {
    if (owned) await fs.rm(temporary, { force: true });
  }
}

async function readHookHealth(directory) {
  const filename = path.join(directory, "logs", "hook-health.json");
  let file;
  try {
    await validateSessionPath(directory);
    await validateDirectoryPath(path.join(directory, "logs"));
    const logs = await fs.lstat(path.dirname(filename));
    if (!logs.isDirectory() || logs.isSymbolicLink()) throw new Error("Unsafe Decision hook health directory");
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 4096) throw new Error("Unsafe Decision hook health");
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > 4096) throw new Error("Unsafe Decision hook health");
    const bytes = await readFileRange(file, 4097, 0);
    if (bytes.length > 4096) throw new Error("Unsafe Decision hook health");
    const health = parseUnsignedJson(bytes,keys => keys.length === 1 &&
      (["version","counter_scheme","last_seen_ms","last_success_ms","last_error_ms","last_skip_ms"].includes(keys[0]) ||
        Object.hasOwn(HEALTH_ACTIVITY_KEYS,keys[0])) || keys.length === 2 && ["skip_counts","skip_details"].includes(keys[0]));
    if (!health || health.version !== 1 || typeof health.hook_version !== "string" ||
        health.hook_version.length > 80 || !/^\d+\.\d+\.\d+$/.test(health.hook_version) ||
        !Number.isSafeInteger(health.last_seen_ms) || health.last_seen_ms <= 0 ||
        health.last_seen_ms > Date.now() + 300_000 ||
        (health.skipped !== undefined && (!Number.isSafeInteger(health.skipped) || health.skipped < 0)) ||
        (health.api_requests !== undefined && (!Number.isSafeInteger(health.api_requests) || health.api_requests < 0)) ||
        Object.keys(HEALTH_ACTIVITY_KEYS).some((key) => health[key] !== undefined &&
          (!Number.isSafeInteger(health[key]) || health[key] < 0)) ||
        ["last_success_ms", "last_error_ms", "last_skip_ms"].some((key) =>
          health[key] !== undefined && (!Number.isSafeInteger(health[key]) || health[key] < 0 ||
            health[key] > health.last_seen_ms)) ||
        ["last_error", "last_skip", "last_skip_detail"].some((key) =>
          health[key] !== undefined && (typeof health[key] !== "string" || health[key].length > 80))) {
      throw new Error("Invalid Decision hook health");
    }
    if (health.skip_counts !== undefined) validateCounterMap(health.skip_counts, "skip counts");
    if (health.skip_details !== undefined) validateCounterMap(health.skip_details, "skip details");
    if (health.counter_scheme !== undefined && health.counter_scheme !== 1) throw new Error("Unsupported Decision counter scheme");
    if (health.counter_scheme === 1 && health.partial_counters === undefined) throw new Error("Missing Decision counter coverage");
    if (health.partial_counters !== undefined && (!Array.isArray(health.partial_counters) ||
        health.partial_counters.length > Object.keys(HEALTH_ACTIVITY_KEYS).length ||
        new Set(health.partial_counters).size !== health.partial_counters.length ||
        health.partial_counters.some((key) => !Object.hasOwn(HEALTH_ACTIVITY_KEYS, key)))) {
      throw new Error("Invalid Decision counter coverage");
    }
    if (health.counter_scheme === 1 && Object.keys(HEALTH_ACTIVITY_KEYS).some((key) =>
      health[key] === undefined && !health.partial_counters.includes(key))) throw new Error("Missing Decision activity counter");
    if (["skip_reasons_partial", "skip_details_partial"].some((key) =>
      health[key] !== undefined && typeof health[key] !== "boolean")) throw new Error("Invalid Decision counter coverage");
    return health;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { await file?.close(); }
}

function validateCounterMap(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length > 80 || Object.entries(value).some(([key, count]) =>
        !/^[a-z][a-z0-9_]{0,79}$/.test(key) || !Number.isSafeInteger(count) || count < 0)) {
    throw new Error(`Invalid Decision ${name}`);
  }
  return value;
}

async function readConfig(directory) {
  try {
    await validateSessionPath(directory);
    const filename = path.join(directory, "config.json");
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 64_000) {
      throw new Error("Unsafe Decision config");
    }
    const record = await readFileRecord(filename, 64_000);
    if (!record) return { enabled: false, mode: "replace" };
    const raw = parseUniqueJson(record.bytes);
    return validate("config", raw);
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, mode: "replace" };
    throw error;
  }
}

async function writeConfig(directory, updates, createOnly = false) {
  return withWriteLock(directory, () => updateConfig(directory, updates, createOnly));
}

async function updateConfig(directory, updates, createOnly) {
  const old = await readConfig(directory);
  const config = validate("config", { ...old, ...updates, schema_version: 5,
    relevance_policy: completeRelevancePolicy(updates.relevance_policy ?? old.relevance_policy) });
  const parent = path.dirname(directory);
  if (path.basename(parent) === "sessions") {
    const root = await fs.lstat(path.dirname(parent));
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Unsafe Decision data directory");
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const sessions = await fs.lstat(parent);
    if (!sessions.isDirectory() || sessions.isSymbolicLink() ||
        (process.platform !== "win32" && (sessions.mode & 0o077))) {
      throw new Error("Unsafe Decision sessions directory");
    }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await fs.lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink() ||
      (process.platform !== "win32" && (folder.mode & 0o077))) {
    throw new Error("Unsafe Decision config directory");
  }
  const target = path.join(directory, "config.json");
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Decision config is a link");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (createOnly) {
    try {
      await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await restrictWslPath(target, false);
      return config;
    } catch (error) {
      if (error.code === "EEXIST") return readConfig(directory);
      throw error;
    }
  }
  await atomicWrite(target, JSON.stringify(config, null, 2) + "\n");
  return config;
}

async function ensureSessionDefaults(directory) {
  if (path.basename(path.dirname(directory)) !== "sessions") {
    throw new Error("Decision defaults require a session directory");
  }
  try {
    await fs.lstat(path.join(directory, "config.json"));
    await secureWslDirectories(directory);
    await secureExistingWslPath(path.join(directory, "config.json"), false);
    return readConfig(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return writeConfig(directory, { enabled: true }, true);
}

async function writeSelection(directory, enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("selection must be a boolean");
  return writeConfig(directory, { enabled });
}

function completeSettings(value) {
  const { schema_version: _version, ...settings } = validate("settings", {
    schema_version: 4, ...DEFAULT_SETTINGS, ...value,
  });
  return settings;
}

async function readGlobalSettings(directory, fallback = {}) {
  await validateSessionPath(directory);
  const filename = path.join(directory, "settings.json");
  try {
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 8192) {
      throw new Error("Unsafe Decision settings file");
    }
    const record = await readFileRecord(filename, 8192);
    if (!record) return completeSettings(fallback);
    const raw = parseUniqueJson(record.bytes);
    if (![1, 2, 3, 4].includes(raw?.schema_version)) throw new Error("Invalid Decision settings version");
    const { schema_version: _version, ...settings } = validate("settings", raw);
    return settings;
  } catch (error) {
    if (error.code === "ENOENT") return completeSettings(fallback);
    throw error;
  }
}

async function writeGlobalSettings(directory, changes, fallback = {}) {
  return withWriteLock(directory, async () => {
    const settings = completeSettings({ ...await readGlobalSettings(directory, fallback), ...changes });
    await atomicWrite(path.join(directory, "settings.json"),
      JSON.stringify({ schema_version: 4, ...settings }, null, 2) + "\n");
    return settings;
  });
}

async function readInstallationStats(directory) {
  const { hookHealth: _health, ...totals } = await readSessionActivity(directory);
  let entries;
  try {
    const parent = await fs.lstat(path.join(directory, "sessions"));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe Decision sessions directory");
    entries = await fs.readdir(path.join(directory, "sessions"), { withFileTypes: true });
  }
  catch (error) {
    if (error.code === "ENOENT") return totals;
    throw error;
  }
  if (entries.length > 10_000) throw new Error("Too many Decision sessions");
  let cursor = 0;
  const add = (previous, amount, name) => {
    if (previous === null || amount === null) return null;
    const value = previous + amount;
    if (Number.isSafeInteger(value)) return value;
    if (!totals.overflowCounters.includes(name)) totals.overflowCounters.push(name);
    return null;
  };
  // Bound both concurrent file descriptors and outstanding filesystem work.
  // One slow session does not serialize every remaining installation read.
  const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe Decision session directory");
      const stats = await readSessionActivity(path.join(directory, "sessions", entry.name));
      for (const key of Object.keys(totals)) {
        if (["averageMs", "estimatedTokensSaved"].includes(key)) continue;
        if (["partialCounters", "overflowCounters"].includes(key)) totals[key] = [...new Set([...totals[key], ...stats[key]])].sort();
        else if (["skipReasonsPartial", "skipDetailsPartial"].includes(key)) totals[key] ||= stats[key];
        else if (["skipCounts", "skipDetails", "candidateReasons"].includes(key)) {
          for (const [reason, count] of Object.entries(stats[key])) {
            const previous = Object.hasOwn(totals[key], reason) ? totals[key][reason] : 0;
            totals[key][reason] = add(previous, count, `${key}.${reason}`);
          }
        } else totals[key] = add(totals[key], stats[key], key);
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  totals.averageMs = totals.elapsedMs === null || totals.timed === null ||
    ["averageMs","elapsedMs","timed"].some(name=>totals.partialCounters.includes(name)) ? null :
    roundedAverage(totals.elapsedMs, totals.timed);
  totals.estimatedTokensSaved = totals.savedChars === null ? null : estimateTokensSaved(totals.savedChars);
  if (totals.overflowCounters.includes("savedChars")) totals.overflowCounters.push("estimatedTokensSaved");
  if (totals.overflowCounters.includes("elapsedMs") || totals.overflowCounters.includes("timed")) totals.overflowCounters.push("averageMs");
  totals.overflowCounters = [...new Set(totals.overflowCounters)].sort();
  return totals;
}

// Request attempts and completion totals have different commit points. The
// hook health counter includes pending and failed API requests; completion
// stats contain only results that published all required artifacts.
async function readSessionActivity(directory) {
  const reads = await Promise.allSettled([
    readRecordedStats(directory), readHookHealth(directory),
  ]);
  const failed = reads.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const recorded = reads[0].value;
  let hookHealth = reads[1].value;
  const totals = await lifetimeStats(directory, recorded);
  // Python-era calls counted pre-transport intents. A migrated or unlabelled
  // ledger cannot prove that those attempts received valid answers.
  const completedCalls = statsBaselineIsFresh(recorded) ? totals.calls : 0;
  if (activityCountersConflict(totals.calls, hookHealth, completedCalls)) {
    hookHealth = await readHookHealth(directory);
    if (activityCountersConflict(totals.calls, hookHealth, completedCalls)) throw new Error("Inconsistent Decision activity counters");
  }
  const hasActivity = hookHealth !== null || recorded !== null || totals.retainedActivity || totals.calls > 0 || totals.completed > 0;
  const unknown = hasActivity ? null : 0;
  const candidateReasons = Object.fromEntries(Object.entries(recorded || {})
    .filter(([key]) => key.startsWith("candidate_")).map(([key, count]) => [key.slice(10), count]));
  validateCounterMap(candidateReasons, "candidate reasons");
  const partial = new Set();
  if (hookHealth) {
    const terminal = hookHealth.responses_validated + hookHealth.request_failures + hookHealth.request_cancelled;
    const pendingOutcomes = !Number.isSafeInteger(hookHealth.api_requests) ||
      !Number.isSafeInteger(terminal) || terminal < hookHealth.api_requests;
    for (const [key, metric] of Object.entries(HEALTH_ACTIVITY_KEYS)) {
      if (hookHealth.counter_scheme !== 1 || hookHealth.partial_counters?.includes(key) ||
          REQUEST_OUTCOME_KEYS.includes(key) && (!requestOutcomesCovered(hookHealth) || pendingOutcomes)) partial.add(metric);
    }
  } else if (hasActivity) partial.add("calls");
  if (recorded) {
    for (const metric of STATS_ACTIVITY_KEYS) {
      if (metric === "calls" && hookHealth?.counter_scheme === 1 && hookHealth.api_requests !== undefined &&
          !hookHealth.partial_counters.includes("api_requests")) continue;
      if (recorded[`partial_${metric}`] === 1 || recorded.counter_scheme !== 1 &&
          (LEGACY_PARTIAL_STATS.includes(metric) || recorded[metric] === undefined)) partial.add(metric);
    }
  } else if (hasActivity) for (const metric of STATS_ACTIVITY_KEYS) {
    if (metric === "calls" && hookHealth?.counter_scheme === 1 && hookHealth.api_requests !== undefined &&
        !hookHealth.partial_counters.includes("api_requests")) continue;
    partial.add(metric);
  }
  const skipReasonsPartial = hookHealth?.skip_reasons_partial ?? (hookHealth !== null);
  const skipDetailsPartial = hookHealth?.skip_details_partial ?? (hookHealth !== null);
  const noRecordedReplacement = recorded?.replaced === 0 && recorded.partial_replaced !== 1;
  const savedChars = recorded?.savedChars ?? (noRecordedReplacement ? 0 :
    recorded === null && totals.completed > 0 ? totals.savedChars : unknown);
  if (noRecordedReplacement && recorded.savedChars === undefined) partial.delete("savedChars");
  if (skipReasonsPartial) partial.add("classificationKeptFull");
  if (partial.has("savedChars")) partial.add("estimatedTokensSaved");
  if (partial.has("elapsedMs") || partial.has("timed")) partial.add("averageMs");
  if (recorded && !statsBaselineIsFresh(recorded)) partial.add("averageMs");
  // Health increments precede completion publication, but these two atomic
  // files can be read on opposite sides of a concurrent completion. Completed
  // requests remain a valid lower bound when the opened health record is older.
  const lineMetrics = Object.fromEntries(STATS_ACTIVITY_KEYS.filter((key) => key.startsWith("lines"))
    .map((key) => [key, recorded?.[key] ?? unknown]));
  return { ...totals, ...lineMetrics, savedChars,
    averageMs: partial.has("averageMs") ? null : totals.averageMs,
    estimatedTokensSaved: savedChars === null ? null : estimateTokensSaved(savedChars),
    calls: Math.max(hookHealth?.api_requests ?? totals.calls, totals.calls),
    linesRelevanceJudged: recorded?.linesRelevanceJudged ?? unknown,
    seen: hookHealth?.seen ?? unknown, skipped: hookHealth?.skipped ?? unknown,
    errors: hookHealth?.errors ?? unknown, candidates: recorded?.candidates ?? unknown,
    requestCancelled: hookHealth?.request_cancelled ?? unknown,
    responsesReceived: hookHealth?.responses_received === undefined ? unknown : Math.max(hookHealth.responses_received, completedCalls),
    responsesValidated: hookHealth?.responses_validated === undefined ? unknown : Math.max(hookHealth.responses_validated, completedCalls),
    requestFailures: hookHealth?.request_failures ?? unknown,
    kept: recorded?.kept ?? unknown, linesActuallyOmitted: recorded?.linesActuallyOmitted ?? unknown,
    classificationKeptFull: hookHealth?.skip_counts ? hookHealth.skip_counts.choice_kept_full_output ?? 0 : unknown,
    skipCounts: { ...hookHealth?.skip_counts }, skipDetails: { ...hookHealth?.skip_details }, candidateReasons,
    partialCounters: [...partial].sort(), overflowCounters: [], skipReasonsPartial, skipDetailsPartial, hookHealth };
}

function activityCountersConflict(recordedCalls, health, completedCalls) {
  if (health?.counter_scheme === 1 && !health.partial_counters.includes("api_requests") &&
      health.api_requests !== undefined && health.api_requests < recordedCalls) return true;
  const fields = ["api_requests", "responses_received", "responses_validated", "request_failures", "request_cancelled"];
  if (health?.counter_scheme !== 1 || !requestOutcomesCovered(health) || fields.some((name) => health[name] === undefined || health.partial_counters.includes(name))) return false;
  const attempts = Math.max(health.api_requests, recordedCalls);
  const received = Math.max(health.responses_received, completedCalls);
  const validated = Math.max(health.responses_validated, completedCalls);
  const terminal = validated + health.request_failures + health.request_cancelled;
  return validated > received || received > attempts - health.request_cancelled ||
    !Number.isSafeInteger(terminal) || terminal > attempts;
}

function requestOutcomesCovered(health) {
  const parts = health?.hook_version?.split(".").map(Number);
  return parts?.length === 3 && parts.every(Number.isSafeInteger) &&
    (parts[0] > 0 || parts[0] === 0 && (parts[1] > 11 || parts[1] === 11 && parts[2] >= 5));
}

async function readFileRange(file, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readRecordedStats(directory) {
  const record = await readPublishedRecord(directory,"stats",options =>
    readFileRecord(path.join(directory,"stats.json"),8192,options));
  return record ? validateStatsRecord(parseUnsignedJson(record.bytes,keys => keys.length === 1)) : null;
}

// A bounded tail restores history without replaying classification pulses.
// Retention can remove older outcomes while leaving cumulative totals intact.
async function readRecentOutcomes(directory, limit = 3) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error("Invalid Decision history limit");
  return withPublication(directory,journal => recentOutcomes(directory,limit,journal?.state === "prepared" ? journal.event_offset : null));
}

async function recentOutcomes(directory, limit, committedOffset) {
  let file;
  try {
    file = await fs.open(await activityLogPath(directory), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const details = await file.stat();
    if (!details.isFile() || !Number.isSafeInteger(details.size) || details.size < 0) throw new Error("Unsafe Decision decision log");
    const size = committedOffset === null ? details.size : Math.min(details.size,committedOffset);
    const start = Math.max(0, size - 262_144);
    const bytes = await readFileRange(file, size - start, start);
    let content = bytes.toString("utf8");
    if (start > 0) content = content.slice(content.indexOf("\n") + 1);
    content = content.slice(0, content.lastIndexOf("\n") + 1);
    return content.split("\n").filter((line) => line.length <= 8192)
      .map(parseLogLine).filter((event) => event && isDecisionOutcome(event)).slice(-limit).reverse();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  } finally { await file?.close(); }
}

async function activityLogPath(directory) {
  const current = path.join(directory, "logs", "events.jsonl");
  try {
    await validateSessionPath(directory);
    await validateDirectoryPath(path.join(directory, "logs"));
    const logs = await fs.lstat(path.join(directory, "logs"));
    if (!logs.isDirectory() || logs.isSymbolicLink()) throw new Error("Unsafe Decision logs directory");
    const index = await fs.lstat(current);
    if (!index.isFile() || index.isSymbolicLink()) throw new Error("Unsafe Decision activity index");
    return current;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return current;
  }
}

function isDecisionOutcome(event) {
  return ["candidate", "keep", "replace"].includes(event.status);
}

function parseLogLine(line) {
  try {
    const row = JSON.parse(line);
    if (!row || typeof row.status !== "string" || typeof row.reason !== "string") return null;
    const counters = ["original_chars","capsule_chars","elapsed_ms","requests","lines_judged",
      "lines_relevance_judged","lines_relevance_kept"];
    if (counters.some(key=>row[key] !== undefined && row[key] !== null &&
        (!Number.isSafeInteger(row[key]) || row[key] < 0))) return null;
    return {
      status: row.status.slice(0, 32), reason: row.reason.slice(0, 64),
      filter: ["test_build", "search_listing"].includes(row.filter) ? row.filter : "output",
      tool: String(row.tool || "").slice(0, 64),
      original_chars: Number(row.original_chars) || 0,
      capsule_chars: typeof row.capsule_chars === "number" && Number.isFinite(row.capsule_chars)
        ? row.capsule_chars : null,
      elapsed_ms: Number(row.elapsed_ms) || 0,
      requests: Number.isSafeInteger(row.requests) && row.requests >= 0 && row.requests <= 10_001
        ? row.requests : 0,
      lines_judged: Number.isSafeInteger(row.lines_judged) && row.lines_judged >= 0 ? row.lines_judged : null,
      lines_relevance_judged: Number.isSafeInteger(row.lines_relevance_judged) && row.lines_relevance_judged >= 0
        ? row.lines_relevance_judged : null,
      lines_relevance_kept: Number.isSafeInteger(row.lines_relevance_kept) && row.lines_relevance_kept >= 0
        ? row.lines_relevance_kept : null,
    };
  } catch { return null; }
}

async function readEventOffset(directory) {
  return withPublication(directory,journal => eventOffset(directory,journal?.state === "prepared" ? journal.event_offset : null));
}

async function eventOffset(directory, committedOffset) {
  try {
    const size = (await fs.stat(await activityLogPath(directory))).size;
    return committedOffset === null ? size : Math.min(size,committedOffset);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function eventCursor(file, offset) {
  const details = await file.stat();
  if (!details.isFile()) throw new Error("Unsafe Decision activity index");
  const length = Math.min(offset, 8192);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset - length);
  const tail = buffer.subarray(0, bytesRead);
  const previousLine = tail.lastIndexOf(10, tail.length - (tail.at(-1) === 10 ? 2 : 1));
  // Include the record ID, not only its tail: two different completion
  // events can end with identical counters or repeated fixture padding.
  const anchor = previousLine >= 0 || offset <= length ? tail.subarray(previousLine + 1) : Buffer.alloc(0);
  return { offset, identity: `${details.dev}:${details.ino}:${details.birthtimeMs}`,
    anchor: anchor.toString("hex") };
}

async function readEventCursor(directory) {
  return withPublication(directory,journal => committedEventCursor(directory,journal?.state === "prepared" ? journal.event_offset : null));
}

async function committedEventCursor(directory, committedOffset) {
  let file;
  try {
    file = await fs.open(await activityLogPath(directory), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const size = (await file.stat()).size;
    return await eventCursor(file, committedOffset === null ? size : Math.min(size,committedOffset));
  } catch (error) {
    if (error.code === "ENOENT") return { offset: 0, identity: null, anchor: "" };
    throw error;
  } finally { await file?.close(); }
}

async function readEventsSince(directory, position) {
  return withPublication(directory,journal => eventsSince(directory,position,journal?.state === "prepared" ? journal.event_offset : null));
}

async function eventsSince(directory, position, committedOffset) {
  const tracked = typeof position === "object" && position !== null;
  let offset = tracked ? position.offset : position;
  const result = async (events, reset, file) => ({ events, offset, reset,
    ...(tracked ? { cursor: file ? await eventCursor(file, offset) : { ...position, offset } } : {}) });
  let file;
  try {
    file = await fs.open(await activityLogPath(directory), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === "ENOENT") {
      const reset = offset > 0;
      offset = 0;
      return result([], reset);
    }
    throw error;
  }
  try {
    const details = await file.stat();
    if (!details.isFile()) throw new Error("Unsafe Decision activity index");
    const size = committedOffset === null ? details.size : Math.min(details.size,committedOffset);
    let reset = offset < 0 || offset > size;
    if (tracked) {
      const identity = `${details.dev}:${details.ino}:${details.birthtimeMs}`;
      const anchor = Buffer.from(position.anchor, "hex");
      if (position.identity !== null && position.identity !== identity) reset = true;
      if (!reset && anchor.length) {
        const previous = Buffer.alloc(anchor.length);
        const { bytesRead } = await file.read(previous, 0, anchor.length, Math.max(0, offset - anchor.length));
        if (bytesRead !== anchor.length || !previous.equals(anchor)) reset = true;
      }
      if (reset) {
        // The hook retains at most a 1 MiB tail on compaction. Resume after
        // the last consumed bytes when they remain in that tail, preserving
        // this view's counters and avoiding duplicate retained events.
        const retained = Buffer.alloc(Math.min(size, 1_048_576));
        const { bytesRead } = await file.read(retained, 0, retained.length, 0);
        const found = anchor.length ? retained.subarray(0, bytesRead).lastIndexOf(anchor) : -1;
        offset = found >= 0 ? found + anchor.length : 0;
      }
    } else if (reset) {
      offset = size;
      return await result([], true, file);
    }
    const length = Math.min(size - offset, 262_144);
    if (!length) return await result([], reset, file);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
    if (end < 0) return await result([], reset, file);
    const complete = buffer.subarray(0, end + 1);
    const events = complete.toString("utf8").split("\n").map(parseLogLine).filter(Boolean);
    offset += complete.length;
    return await result(events, reset, file);
  } finally {
    await file.close();
  }
}

async function readLifetimeStats(directory) {
  return lifetimeStats(directory, await readRecordedStats(directory));
}

async function lifetimeStats(directory, stats) {
  const totals = { calls: 0, completed: 0, replaced: 0, savedChars: 0,
    estimatedTokensSaved: 0, averageMs: 0, timed: 0, elapsedMs: 0, linesSeen: 0, linesJudged: 0,
    linesKept: 0, linesOmitted: 0, linesProtected: 0, linesUnjudged: 0,
    linesRelevanceJudged: 0, linesBelowOmitCutoff: 0, linesRelevanceKept: 0 };
  if (stats !== null) {
    for (const key of ["calls", "completed", "replaced", "timed", "elapsedMs"]) {
      if (!Number.isSafeInteger(stats[key]) || stats[key] < 0) throw new Error("Invalid Decision stats file");
    }
    const savedChars = stats.savedChars ?? 0;
    if (!Number.isSafeInteger(savedChars) || savedChars < 0) throw new Error("Invalid Decision stats file");
    const lineStats = Object.fromEntries(["linesSeen", "linesJudged", "linesKept", "linesOmitted",
      "linesProtected", "linesUnjudged", "linesRelevanceJudged", "linesBelowOmitCutoff", "linesRelevanceKept"].map((key) => {
      const value = stats[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Decision line stats");
      return [key, value];
    }));
    return { calls: stats.calls, completed: stats.completed, replaced: stats.replaced,
      savedChars, estimatedTokensSaved: estimateTokensSaved(savedChars),
      averageMs: !statsBaselineIsFresh(stats) ? null :
        roundedAverage(stats.elapsedMs, stats.timed), timed: stats.timed, elapsedMs: stats.elapsedMs, ...lineStats };
  }
  return withPublication(directory,journal => retainedStats(directory,{...totals},journal?.state === "prepared" ? journal.event_offset : null));
}

async function retainedStats(directory, totals, committedOffset) {
  const filename = await activityLogPath(directory);
  let file;
  try {
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Unsafe Decision decision log");
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error.code === "ENOENT") return totals;
    throw error;
  }
  try {
    const details = await file.stat();
    if (!details.isFile()) throw new Error("Unsafe Decision decision log");
    const visible = committedOffset === null ? details.size : Math.min(details.size,committedOffset);
    if (visible === 0) return totals;
    Object.defineProperty(totals,"retainedActivity",{value:true});
    const start = Math.max(0,visible-1_048_576);
    Object.assign(totals,retainedStatsFromEvents(await readFileRange(file,visible-start,start),start>0));
  } finally {
    await file.close();
  }
  totals.estimatedTokensSaved = estimateTokensSaved(totals.savedChars);
  totals.averageMs = totals.retainedActivity ? null : 0;
  return totals;
}

// Match the bounded Rust retained-event reader. Corrupted rows cannot supply
// partial completions or rounded counters, and EOF is not a commit boundary.
function retainedStatsFromEvents(bytes, truncated = false) {
  const totals = {calls:0,completed:0,replaced:0,timed:0,elapsedMs:0,savedChars:0};
  const begin = truncated ? bytes.indexOf(10)+1 || bytes.length : 0;
  const end = Math.max(begin,bytes.lastIndexOf(10)+1);
  const unsigned = ["requests","elapsed_ms","original_chars","capsule_chars","lines_judged",
    "lines_relevance_judged","lines_relevance_kept"];
  const add = (name,amount) => {
    const next = totals[name]+amount;
    if (!Number.isSafeInteger(next) || next < 0) throw new Error("Decision retained activity exceeds the exact numeric range");
    totals[name] = next;
  };
  let from = begin;
  while (from < end) {
    const next = bytes.indexOf(10,from);
    const row = bytes.subarray(from,next);from=next+1;
    if (row.length > 8192) continue;
    let event;
    try {
      event = parseUnsignedJson(row,keys=>keys.length === 1 && unsigned.includes(keys[0]),
        keys=>keys.length === 1 && unsigned.includes(keys[0]) && keys[0] !== "requests");
      if (!event || typeof event.status !== "string" || typeof event.reason !== "string" ||
          unsigned.some(name=>event[name] !== undefined && event[name] !== null &&
            (!Number.isSafeInteger(event[name]) || event[name] < 0 || name === "requests" && event[name]>10_001))) continue;
    } catch (error) {if (error.code === "DECISION_COUNTER_RANGE") throw error;continue;}
    const requests=event.requests ?? 0;
    add("calls",event.status === "calling" ? 1 : requests);
    if ((isDecisionOutcome(event) || event.reason === "choice_kept_full_output") && event.elapsed_ms>0) {
      add("timed",requests || 1);add("elapsedMs",event.elapsed_ms);
    }
    if (!isDecisionOutcome(event)) continue;
    add("completed",1);
    if (event.status === "replace") {
      add("replaced",1);add("savedChars",savedCharacters(event));
    }
  }
  return totals;
}

function outcomeLine(event) {
  const action = event.status === "replace" ? "replaced" :
    event.status === "candidate" ? "candidate" : "kept";
  const mode = event.reason === "observe" ? " (monitor)" : "";
  const savedChars = savedCharacters(event);
  const saved = savedChars > 0
    ? ` · -${Math.round(100 * savedChars / event.original_chars)}%`
    : "";
  const source = event.tool || "tool";
  return `${action}${mode} · ${source} · ${event.original_chars.toLocaleString("en-US")} chars${saved}`;
}

function savedCharacters(event) {
  return event.status === "replace" && Number.isFinite(event.original_chars) &&
    Number.isFinite(event.capsule_chars) && event.original_chars > 0 &&
    event.capsule_chars >= 0 && event.capsule_chars <= event.original_chars
    ? event.original_chars - event.capsule_chars : 0;
}

function statsBaselineIsFresh(stats) {
  return stats?.counter_scheme === 1 && !Object.entries(stats).some(
    ([name,value])=>name.startsWith("partial_") && value === 1);
}

function roundedAverage(elapsed, timed) {
  if (!timed) return 0;
  const remainder = elapsed % timed;
  return (elapsed - remainder) / timed + Number(remainder >= Math.ceil(timed / 2));
}

function estimateTokensSaved(characters) {
  // OpenAI's plain-text rule of thumb is approximately four characters per token.
  return Number.isFinite(characters) && characters > 0 ? Math.round(characters / 4) : 0;
}

function decisionSummary(event) {
  if (!event) return "No hook decision recorded yet";
  if (event.status === "calling") return `Checking ${event.tool || "tool"} output with Decision`;
  const action = event.status === "replace" ? "replaced" :
    event.status === "candidate" ? "candidate" :
    event.status === "keep" ? "kept" : "skipped";
  return `Last decision: ${action} ${event.tool || "tool"} output (${event.reason}); ${event.original_chars.toLocaleString("en-US")} chars`;
}

function parseHealthOutput(stdout, selected = "openai") {
  return parseHealthResult(JSON.parse(stdout), selected);
}

async function readApiKey(directory, selected = "openai") {
  const keyName = provider(selected).keyName;
  await validateSessionPath(directory);
  const filename = path.join(directory, ".env");
  const details = await fs.lstat(filename);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 8192 ||
      (process.platform !== "win32" && (details.mode & 0o077))) throw new Error("Unsafe Decision credential file");
  const lines = (await fs.readFile(filename, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/);
  const values = lines.filter((line) => line.trim().split("=", 1)[0].trim() === keyName).map((line) => {
    let value = line.slice(line.indexOf("=") + 1).trim();
    if (value.length >= 2 && ["'", '"'].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
    return value;
  });
  if (values.length !== 1 || values[0].length < 8 || values[0].length > 4096 || /\s|\0/.test(values[0])) {
    throw new Error("Decision API key is missing or invalid");
  }
  return values[0];
}

async function boundedResponse(response, limit) {
  if (!response.body?.getReader) {
    // Small injected responses used by callers without a Fetch stream.
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error("Decision response too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Decision response too large"); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

async function checkHealth(dataDirectory, send = globalThis.fetch, suppliedKey = null, selected = null) {
  try { selected ??= (await readGlobalSettings(dataDirectory)).provider; provider(selected); }
  catch { return { ok: false, reason: "DECISION_INVALID_SETTINGS" }; }
  let key;
  try {
    key = suppliedKey === null ? await readApiKey(dataDirectory, selected) : validateApiKey(suppliedKey);
  } catch {
    return { ok: false, reason: "DECISION_KEY_MISSING" };
  }
  const body = JSON.stringify(wireRequest({
    state: { output_sample: "Compiling module 1 done\nCompiling module 2 done" },
    model: provider(selected).model,
    questions: { ready: { type: "noul", instructions: "Is output_sample routine build progress?" } },
  }));
  let response;
  try {
    response = await send(provider(selected).endpoint, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(6000), redirect: "error",
    });
  } catch (error) {
    return { ok: false, reason: ["AbortError", "TimeoutError"].includes(error?.name)
      ? "DECISION_TIMEOUT" : "DECISION_NETWORK_ERROR" };
  }
  if (!response || typeof response.ok !== "boolean") {
    return { ok: false, reason: "DECISION_INVALID_RESPONSE" };
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status) && typeof response.text === "function") {
      try {
        const error = JSON.parse(await boundedResponse(response, 4096));
        const details = [error.code, error.message, error.error?.code, error.error?.message];
        if (details.some((value) => typeof value === "string" && /expir/i.test(value))) {
          return { ok: false, reason: "DECISION_KEY_EXPIRED" };
        }
      } catch { /* An unstructured error keeps its HTTP status. */ }
    }
    return { ok: false, reason: `DECISION_HTTP_${response.status}` };
  }
  try {
    const output = await boundedResponse(response, 262144);
    return parseHealthOutput(output, selected);
  } catch {
    return { ok: false, reason: "DECISION_INVALID_RESPONSE" };
  }
}

function validateApiKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 4096 || /\s|\0/.test(key)) {
    throw new Error("Decision API key is missing or invalid");
  }
  return key;
}

async function writeApiKey(directory, key, selected = "openai") {
  provider(selected);
  return withWriteLock(directory, () => updateApiKey(directory, key, selected));
}

async function updateApiKey(directory, key, selected) {
  const keyName = provider(selected).keyName;
  validateApiKey(key);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) {
    throw new Error("Unsafe plugin data directory");
  }
  await validateSessionPath(directory);
  const target = path.join(directory, ".env");
  let lines = [];
  try {
    const details = await fs.lstat(target);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 8192 ||
        (process.platform !== "win32" && (details.mode & 0o077))) throw new Error("Unsafe Decision credential file");
    lines = (await fs.readFile(target, "utf8")).split(/\r?\n/)
      .filter((line) => line.trim().split("=", 1)[0].trim() !== keyName);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const content = [...lines.filter(Boolean), `${keyName}=${key}`].join("\n") + "\n";
  if (Buffer.byteLength(content) > 8192) throw new Error("Decision credential file is too large");
  const temporary = path.join(directory, `.env-${crypto.randomUUID()}.tmp`);
  let owned = false;
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    owned = true;
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await fs.chmod(temporary, 0o600);
    if (process.platform === "win32") {
      const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([A-Za-z0-9_-]+)\\(.+)$/i.exec(temporary);
      if (match) await runFile("wsl.exe", ["-d", match[1], "-e", "chmod", "600", `/${match[2].replaceAll("\\", "/")}`]);
    }
    await fs.rename(temporary, target);
  } finally {
    if (owned) await fs.rm(temporary, { force: true });
  }
}

module.exports = {
  checkHealth, sessionDirectory, validateSessionPath, validateDirectoryPath, readHookHealth,
  completeRelevancePolicy, DEFAULT_RELEVANCE_POLICY,

  decisionSummary, defaultDataDirectory, estimateTokensSaved,
  isDecisionOutcome, outcomeLine, parseHealthOutput, readConfig,
  readApiKey, readEventOffset, readEventCursor, readEventsSince, readLifetimeStats,
  readSessionActivity, readRecentOutcomes, retainedStatsFromEvents,
  savedCharacters, writeApiKey, writeSelection,
  ensureSessionDefaults,
  DEFAULT_SETTINGS, readGlobalSettings, writeGlobalSettings, readInstallationStats,
};
