"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const path = require("node:path");
const { restrictWslPath, wslLocation } = require("./private-paths");
const securedWslPaths = new Map();
const { provider, parseHealthResult } = require("./providers");
const { defaults, validate } = require("./schema");
const { readFileRecord,
  validateDirectoryPath,validateSessionPath,parseUniqueJson,parseUnsignedJson } = require("./private-records");
const {withPublication} = require("./publication-journal");
const { createActivityReader } = require("./activity-cache");
const { bundledCommands, activityView, providerProbe } = require("./native-command");
const nativeCommands = bundledCommands(__dirname);
const DEFAULT_RELEVANCE_POLICY = Object.freeze(defaults("config").relevance_policy);
const { schema_version: _schemaVersion, ...settingsDefaults } = defaults("settings");
const DEFAULT_SETTINGS = Object.freeze(settingsDefaults);
const CREDENTIAL_FILE_LIMIT = 16384;
const HEALTH_ACTIVITY_KEYS = Object.freeze({ seen: "seen", skipped: "skipped", errors: "errors",
  api_requests: "calls", request_cancelled: "requestCancelled", responses_received: "responsesReceived",
  responses_validated: "responsesValidated", request_failures: "requestFailures" });
const legacyActivity = nativeCommands ? null : require("./activity-reference")({
  readSessionActivity: directory => readSessionActivity(directory),
  readHookHealth, readFileRange, validateCounterMap, activityLogPath, isDecisionOutcome,
  savedCharacters, estimateTokensSaved, HEALTH_ACTIVITY_KEYS,
});
const readSessionActivity = createActivityReader(legacyActivity?.readSessionActivityUncached ||
  (directory => activityView(nativeCommands, directory, "--session-directory")));
const { readLifetimeStats, retainedStatsFromEvents } = legacyActivity || {};
function completeRelevancePolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid relevance policy");
  return validate("relevance_threshold", { ...DEFAULT_RELEVANCE_POLICY, ...value });
}

function describeHookActivity(enabled, health) {
  if (!enabled) return { kind: "disabled", message: "Decision is off for this thread." };
  if (health?.fault) return { kind: "error", message: health.fault };
  if (!health) return { kind: "waiting", message: "Waiting for tool output.",
    detail: "If no activity appears, check /hooks. Then start a new thread." };
  const latest = Math.max(health.last_skip_ms || 0, health.last_success_ms || 0);
  if (health.last_error_ms > 0 && health.last_error_ms >= latest) {
    return { kind: "error", message: "Hook error. Full output kept.",
      detail: health.last_error || "Tool output could not be evaluated." };
  }
  if (health.last_skip_ms > 0 && health.last_skip_ms >= (health.last_success_ms || 0)) {
    const reasons = {
      choice_kept_full_output: "Complete output kept.",
      unsupported_route: "Tool format not supported. Full output kept.",
      unsupported_result: "Response format not supported. Full output kept.",
      mcp_replacement_disabled: "MCP filtering is off. Full output kept.",
      small: "Output too short to check.",
      sensitive: "Private output kept locally.",
      unsafe_task_context: "Private task context kept locally.",
      exact_content: "Exact text needed. Full output kept.",
      exhaustive_task: "Complete result needed. Full output kept.",
      structure_guard: "Line format not verified. Full output kept.",
      insufficient_savings: "Too little text to remove. Full output kept.",
    };
    return { kind: "skip", message: reasons[health.last_skip] ||
      `Output kept: ${(health.last_skip || "unknown").replaceAll("_", " ")}.` };
  }
  return { kind: "ready", message: "Waiting for tool output." };
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
  const temporary = path.join(path.dirname(target), `.decision-${crypto.randomUUID()}.tmp`);
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
    if (!details.isFile() || details.isSymbolicLink() || details.size > 65536) {
      throw new Error("Unsafe Decision settings file");
    }
    const record = await readFileRecord(filename, 65536);
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

function readInstallationStats(directory) {
  return legacyActivity ? legacyActivity.readInstallationStats(directory) :
    activityView(nativeCommands, directory, "--installation");
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

function parseHealthOutput(stdout, selected = "openai", custom) {
  return parseHealthResult(JSON.parse(stdout), selected, custom);
}

function customCredentialIdentity(custom) {
  const spec = provider("custom", custom);
  const identity = [spec.endpoint, spec.auth, spec.username, spec.header_name];
  if (spec.ca_certificate) identity.push(spec.ca_certificate);
  return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function validateCustomSecret(secret, password = false) {
  if (typeof secret !== "string" || !secret.length || Buffer.byteLength(secret) > 4096 ||
      (password ? /\p{Cc}/u : /[^\x20-\x7e]/).test(secret)) throw new Error("Enter a valid provider credential");
  return secret;
}

async function credentialSource(directory) {
  let record;
  let source;
  try {
    await validateSessionPath(directory);
    record = await readFileRecord(path.join(directory, ".env"), CREDENTIAL_FILE_LIMIT, { strict: true });
    if (record) source = new TextDecoder("utf-8", { fatal: true }).decode(record.bytes);
  } catch {
    throw Object.assign(new Error("Unsafe Decision credential file"), { decisionReason: "DECISION_CREDENTIAL_UNSAFE" });
  }
  return source?.replace(/^\uFEFF/, "") || "";
}

async function readApiKey(directory, selected = "openai", custom) {
  if (selected === "custom") custom ??= (await readGlobalSettings(directory)).custom_provider;
  if (selected === "custom" && provider(selected, custom).auth === "none") return "";
  return apiKeyFromSource(await credentialSource(directory), selected, custom);
}

function apiKeyFromSource(source, selected, custom) {
  if (selected === "custom") {
    const spec = provider(selected, custom);
    if (spec.auth === "none") return "";
    const lines = source.split(/\r?\n/);
    const values = name => lines.filter(line => line.split("=", 1)[0] === name).map(line => line.slice(line.indexOf("=") + 1));
    const identity = values("CUSTOM_CREDENTIAL_IDENTITY");
    const secrets = values(spec.keyName);
    if (identity.length !== 1 || identity[0] !== customCredentialIdentity(custom) || secrets.length !== 1)
      throw Object.assign(new Error("Enter credentials for this custom connection"), { decisionReason: "DECISION_KEY_MISSING" });
    try { return validateCustomSecret(secrets[0], spec.auth === "basic"); }
    catch { throw Object.assign(new Error("Invalid custom credential"), { decisionReason: "DECISION_KEY_INVALID" }); }
  }
  const keyName = provider(selected).keyName;
  const lines = source.split(/\r?\n/);
  const values = lines.filter((line) => line.trim().split("=", 1)[0].trim() === keyName).map((line) => {
    let value = line.slice(line.indexOf("=") + 1).trim();
    if (value.length >= 2 && ["'", '"'].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
    return value;
  });
  if (!values.length) throw Object.assign(new Error("Decision API key is missing or invalid"), { decisionReason: "DECISION_KEY_MISSING" });
  if (values.length !== 1 || !/^[\x21-\x7e]{8,4096}$/.test(values[0])) {
    throw Object.assign(new Error("Decision API key is missing or invalid"), { decisionReason: "DECISION_KEY_INVALID" });
  }
  return values[0];
}

async function readProviderKeys(directory, customProvider) {
  return (await readProviderKeySnapshot(directory, "openai", customProvider)).providerKeys;
}

async function readProviderKeySnapshot(directory, selected = "openai", customProvider) {
  customProvider ??= (await readGlobalSettings(directory).catch(() => ({}))).custom_provider;
  let source;
  try { source = await credentialSource(directory); } catch { /* Report unusable saved credentials without exposing them. */ }
  const providerKeys = {};
  let keyLength = 0;
  for (const name of ["openai", "typesafe", ...(customProvider ? ["custom"] : [])]) {
    try {
      const noAuth = name === "custom" && provider(name, customProvider).auth === "none";
      if (!noAuth && source === undefined) throw new Error("Unusable credential snapshot");
      const key = noAuth ? "" : apiKeyFromSource(source, name, customProvider);
      providerKeys[name] = { hasKey: noAuth || Boolean(key) };
      if (name === selected) keyLength = key.length;
    } catch { providerKeys[name] = { hasKey: false }; }
  }
  return { providerKeys, keyLength };
}


async function checkHealth(dataDirectory, send = globalThis.fetch, suppliedKey = null, selected = null, options = {}) {
  const timeoutMs = Math.max(1, Math.min(6000, Number.isFinite(options.timeoutMs) ? Math.ceil(options.timeoutMs) : 6000));
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  if (options.signal?.aborted) return { ok: false, reason: "DECISION_CANCELLED" };
  let spec;
  let custom;
  try {
    const settings = selected === null || (selected === "custom" && !options.customProvider) ? await readGlobalSettings(dataDirectory) : {};
    selected ??= settings.provider;
    custom = options.customProvider || settings.custom_provider;
    spec = provider(selected, custom);
  }
  catch { return { ok: false, reason: "DECISION_INVALID_SETTINGS" }; }
  let key;
  try {
    key = spec.auth === "none" ? "" : selected === "custom" ?
      (spec.auth === "basic" ? options.password : suppliedKey) || await readApiKey(dataDirectory, selected, custom) :
      suppliedKey === null ? await readApiKey(dataDirectory, selected) : validateApiKey(suppliedKey);
    if (selected === "custom" && spec.auth !== "none") validateCustomSecret(key, spec.auth === "basic");
  } catch (error) {
    return { ok: false, reason: error.decisionReason || "DECISION_KEY_INVALID" };
  }
  if (nativeCommands) {
    const { keyName: _keyName, ...customSettings } = spec;
    const result = await providerProbe(nativeCommands, dataDirectory)({ provider: selected,
      custom_provider: selected === "custom" ? customSettings : undefined, credential: key, timeout_ms: timeoutMs }, signal);
    return options.signal?.aborted ? { ok: false, reason: "DECISION_CANCELLED" } : result;
  }
  return require("./probe-reference").probeReference(spec, selected, custom, key, send, signal, options);
}

function validateApiKey(key) {
  if (typeof key !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(key)) {
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
  return updateCredentials(directory, { [keyName]: key });
}

// Validate the full draft before changing either settings or credentials. Binding the
// custom credential to its destination also protects externally edited config files.
async function saveProviderSettings(directory, changes, secrets = {}, fallback = {}) {
  return withWriteLock(directory, async () => {
    const current = await readGlobalSettings(directory, fallback);
    const settings = completeSettings({ ...current, ...changes });
    if (settings.provider === "custom") {
      const spec = provider("custom", settings.custom_provider);
      const entered = spec.auth === "basic" ? secrets.password : secrets.key;
      const sameIdentity = current.custom_provider && customCredentialIdentity(current.custom_provider) === customCredentialIdentity(settings.custom_provider);
      if (spec.auth !== "none" && !entered && !sameIdentity) throw new Error("Enter credentials for this custom connection");
      if (entered && spec.auth !== "none") validateCustomSecret(entered, spec.auth === "basic");
      if (spec.auth === "none" || entered) await updateCredentials(directory, {
        CUSTOM_API_KEY: spec.auth !== "basic" && spec.auth !== "none" ? entered : null,
        CUSTOM_PASSWORD: spec.auth === "basic" ? entered : null,
        CUSTOM_CREDENTIAL_IDENTITY: spec.auth === "none" ? null : customCredentialIdentity(settings.custom_provider),
      });
    } else if (secrets.key) {
      validateApiKey(secrets.key);
      await updateCredentials(directory, { [provider(settings.provider).keyName]: secrets.key });
    }
    await atomicWrite(path.join(directory, "settings.json"), JSON.stringify({ schema_version: 4, ...settings }, null, 2) + "\n");
    return settings;
  });
}

async function updateCredentials(directory, values) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) {
    throw new Error("Unsafe plugin data directory");
  }
  await validateSessionPath(directory);
  const target = path.join(directory, ".env");
  let lines = [];
  const existing = await readFileRecord(target, CREDENTIAL_FILE_LIMIT, { strict: true });
  if (existing) {
    lines = new TextDecoder("utf-8", { fatal: true }).decode(existing.bytes).split(/\r?\n/)
      .filter((line) => !Object.hasOwn(values, line.trim().split("=", 1)[0].trim()));
  }
  const content = [...lines.filter(Boolean), ...Object.entries(values).filter(([, value]) => value !== null).map(([name, value]) => `${name}=${value}`)].join("\n") + "\n";
  if (Buffer.byteLength(content) > CREDENTIAL_FILE_LIMIT) throw new Error("Decision credential file is too large");
  await atomicWrite(target, content);
}

module.exports = {
  checkHealth, sessionDirectory, validateSessionPath, validateDirectoryPath, readHookHealth,
  completeRelevancePolicy, DEFAULT_RELEVANCE_POLICY,

  decisionSummary, defaultDataDirectory, estimateTokensSaved,
  isDecisionOutcome, outcomeLine, parseHealthOutput, readConfig,
  readApiKey, readProviderKeys, readProviderKeySnapshot, readEventOffset, readEventCursor, readEventsSince, readLifetimeStats,
  readSessionActivity, readRecentOutcomes, retainedStatsFromEvents,
  describeHookActivity,
  savedCharacters, writeApiKey, writeSelection, saveProviderSettings, customCredentialIdentity,
  ensureSessionDefaults,
  DEFAULT_SETTINGS, readGlobalSettings, writeGlobalSettings, readInstallationStats,
};
