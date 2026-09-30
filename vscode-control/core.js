"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const readline = require("node:readline");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_LINE_POLICY = Object.freeze({
  output: { omit_min: 95, exact_max: 5 },
  test_build: { omit_min: 95, exact_max: 5 },
  search_listing: { omit_min: 95, exact_max: 5 },
});
const DEFAULT_SEARCH_RELEVANCE = Object.freeze({ guard_enabled: false, relevant_max: 5 });
const CONFIG_KEYS = new Set([
  "enabled", "test_build_enabled", "search_listing_enabled", "mode", "min_chars", "max_chars",
  "timeout_seconds", "model", "allow_mcp_replacement",
  "log_limit_mb", "never_delete_logs", "schema_version", "line_policy", "search_relevance",
  "choice_gate_enabled",
]);

function completeSearchRelevance(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_SEARCH_RELEVANCE, key))) {
    throw new Error("Invalid search relevance policy");
  }
  const policy = { ...DEFAULT_SEARCH_RELEVANCE, ...value };
  if (typeof policy.guard_enabled !== "boolean" || !Number.isInteger(policy.relevant_max) ||
      policy.relevant_max < 0 || policy.relevant_max > 100) {
    throw new Error("Invalid search relevance policy");
  }
  return policy;
}

function completeLinePolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((route) => !Object.hasOwn(DEFAULT_LINE_POLICY, route))) {
    throw new Error("Invalid Jev line policy");
  }
  return Object.fromEntries(Object.entries(DEFAULT_LINE_POLICY).map(([route, defaults]) => {
    const entered = value[route] ?? {};
    if (!entered || typeof entered !== "object" || Array.isArray(entered) ||
        Object.keys(entered).some((key) => !Object.hasOwn(defaults, key))) {
      throw new Error("Invalid Jev line policy");
    }
    const merged = { ...defaults, ...entered };
    if (Object.values(merged).some((number) => !Number.isInteger(number) || number < 0 || number > 100)) {
      throw new Error("Jev line policy requires whole percentages from 0 to 100");
    }
    return [route, merged];
  }));
}

function defaultDataDirectory() {
  return process.env.CODEX_JEV_DATA_DIRECTORY || "";
}

function sessionDirectory(directory, sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    throw new Error("Jev needs a valid Codex session ID");
  }
  return path.join(directory, "sessions", crypto.createHash("sha256").update(sessionId).digest("hex"));
}

async function validateSessionPath(directory) {
  const parent = path.dirname(directory);
  if (path.basename(parent) !== "sessions") return;
  for (const folder of [parent, directory]) {
    const details = await fs.lstat(folder);
    if (!details.isDirectory() || details.isSymbolicLink() ||
        (process.platform !== "win32" && (details.mode & 0o077))) {
      throw new Error("Unsafe Jev session directory");
    }
  }
}

async function readHookHealth(directory) {
  const filename = path.join(directory, "logs", "hook-health.json");
  try {
    await validateSessionPath(directory);
    const logs = await fs.lstat(path.dirname(filename));
    if (!logs.isDirectory() || logs.isSymbolicLink()) throw new Error("Unsafe Jev hook health directory");
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 4096) throw new Error("Unsafe Jev hook health");
    const health = JSON.parse(await fs.readFile(filename, "utf8"));
    if (!health || health.version !== 1 || typeof health.hook_version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(health.hook_version) ||
        !Number.isSafeInteger(health.last_seen_ms) || health.last_seen_ms <= 0 ||
        health.last_seen_ms > Date.now() + 300_000 ||
        ["last_success_ms", "last_error_ms", "last_skip_ms"].some((key) =>
          health[key] !== undefined && (!Number.isSafeInteger(health[key]) || health[key] < 0 ||
            health[key] > health.last_seen_ms)) ||
        ["last_error", "last_skip"].some((key) =>
          health[key] !== undefined && (typeof health[key] !== "string" || health[key].length > 80))) {
      throw new Error("Invalid Jev hook health");
    }
    return health;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readConfig(directory) {
  try {
    await validateSessionPath(directory);
    const filename = path.join(directory, "config.json");
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 64_000) {
      throw new Error("Unsafe Jev config");
    }
    const raw = JSON.parse(await fs.readFile(filename, "utf8"));
    const merged = {
      enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace", min_chars: 256, max_chars: 2_000_000,
      timeout_seconds: 3, model: "jev-latest",
      allow_mcp_replacement: false, log_limit_mb: 50, never_delete_logs: false,
      choice_gate_enabled: true, ...raw,
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).some((key) => !CONFIG_KEYS.has(key)) ||
        ["enabled", "test_build_enabled", "search_listing_enabled", "mode"].some((key) => !Object.hasOwn(raw, key)) ||
        !raw.line_policy || typeof raw.line_policy !== "object" || Array.isArray(raw.line_policy) ||
        ["output", "test_build", "search_listing"].some((key) => !Object.hasOwn(raw.line_policy, key)) ||
        typeof merged.enabled !== "boolean" || typeof merged.test_build_enabled !== "boolean" ||
        typeof merged.search_listing_enabled !== "boolean" ||
        !["observe", "replace"].includes(merged.mode) ||
        !Number.isInteger(merged.min_chars) || !Number.isInteger(merged.max_chars) ||
        merged.min_chars < 256 || merged.min_chars > merged.max_chars || merged.max_chars > 2_000_000 ||
        typeof merged.timeout_seconds !== "number" || merged.timeout_seconds < 0.1 || merged.timeout_seconds > 4 ||
        typeof merged.model !== "string" || !/^jev-[\w.-]{1,40}$/.test(merged.model) ||
        typeof merged.allow_mcp_replacement !== "boolean" ||
        typeof merged.choice_gate_enabled !== "boolean" ||
        !Number.isInteger(merged.log_limit_mb) || merged.log_limit_mb < 1 || merged.log_limit_mb > 9999 ||
        typeof merged.never_delete_logs !== "boolean" ||
        merged.schema_version !== 2) {
      throw new Error("Invalid Jev config");
    }
    completeLinePolicy(merged.line_policy);
    completeSearchRelevance(merged.search_relevance);
    return { enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace", ...raw };
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace" };
    throw error;
  }
}

async function writeConfig(directory, updates, createOnly = false) {
  const old = await readConfig(directory);
  const config = { ...old, ...updates, schema_version: 2,
    line_policy: completeLinePolicy(updates.line_policy ?? old.line_policy),
    search_relevance: completeSearchRelevance(updates.search_relevance ?? old.search_relevance) };
  const parent = path.dirname(directory);
  if (path.basename(parent) === "sessions") {
    const root = await fs.lstat(path.dirname(parent));
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Unsafe Jev data directory");
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const sessions = await fs.lstat(parent);
    if (!sessions.isDirectory() || sessions.isSymbolicLink() ||
        (process.platform !== "win32" && (sessions.mode & 0o077))) {
      throw new Error("Unsafe Jev sessions directory");
    }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await fs.lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink() ||
      (process.platform !== "win32" && (folder.mode & 0o077))) {
    throw new Error("Unsafe Jev config directory");
  }
  const target = path.join(directory, "config.json");
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Jev config is a link");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (createOnly) {
    try {
      await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return config;
    } catch (error) {
      if (error.code === "EEXIST") return readConfig(directory);
      throw error;
    }
  }
  const temporary = path.join(directory, `.config-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return config;
}

async function ensureSessionDefaults(directory) {
  if (path.basename(path.dirname(directory)) !== "sessions") {
    throw new Error("Jev defaults require a session directory");
  }
  try {
    await fs.lstat(path.join(directory, "config.json"));
    return readConfig(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return writeConfig(directory, { enabled: true, test_build_enabled: true,
    search_listing_enabled: true }, true);
}

async function writeEnabled(directory, enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  return writeConfig(directory, { enabled });
}

async function writeSelection(directory, outputEnabled, testBuildEnabled, searchListingEnabled) {
  if (typeof outputEnabled !== "boolean" || typeof testBuildEnabled !== "boolean" ||
      (searchListingEnabled !== undefined && typeof searchListingEnabled !== "boolean")) {
    throw new TypeError("selection must contain booleans");
  }
  return writeConfig(directory, {
    enabled: outputEnabled, test_build_enabled: testBuildEnabled,
    ...(searchListingEnabled === undefined ? {} : { search_listing_enabled: searchListingEnabled }),
  });
}

async function writeMode(directory, mode) {
  if (!["replace", "observe"].includes(mode)) throw new TypeError("invalid Jev mode");
  return writeConfig(directory, { mode });
}

async function writeSettings(directory, mode, linePolicy, limitMb, neverDelete,
  searchRelevance = DEFAULT_SEARCH_RELEVANCE, choiceGateEnabled = true) {
  if (!["replace", "observe"].includes(mode)) throw new TypeError("invalid Jev mode");
  if (!Number.isInteger(limitMb) || limitMb < 1 || limitMb > 9999 ||
      typeof neverDelete !== "boolean" || typeof choiceGateEnabled !== "boolean") {
    throw new TypeError("Log retention must be 1 to 9999 MB");
  }
  return writeConfig(directory, { mode, line_policy: completeLinePolicy(linePolicy),
    search_relevance: completeSearchRelevance(searchRelevance),
    choice_gate_enabled: choiceGateEnabled, log_limit_mb: limitMb, never_delete_logs: neverDelete });
}

async function writeNeverDeleteLogs(directory, neverDelete) {
  if (typeof neverDelete !== "boolean") throw new TypeError("Never delete logs must be a boolean");
  return writeConfig(directory, { never_delete_logs: neverDelete });
}

async function activityLogPath(directory) {
  const current = path.join(directory, "logs", "events.jsonl");
  try {
    await validateSessionPath(directory);
    const logs = await fs.lstat(path.join(directory, "logs"));
    if (!logs.isDirectory() || logs.isSymbolicLink()) throw new Error("Unsafe Jev logs directory");
    const index = await fs.lstat(current);
    if (!index.isFile() || index.isSymbolicLink()) throw new Error("Unsafe Jev activity index");
    return current;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return current;
  }
}

function isJevOutcome(event) {
  return ["candidate", "keep", "replace"].includes(event.status);
}

function isInformativeEvent(event) {
  return event.status !== "calling" &&
    !(event.status === "skip" && ["small", "unsupported_event", "unsupported_result"].includes(event.reason));
}

function parseLogLine(line) {
  try {
    const row = JSON.parse(line);
    if (!row || typeof row.status !== "string" || typeof row.reason !== "string") return null;
    return {
      status: row.status.slice(0, 32), reason: row.reason.slice(0, 64),
      filter: ["test_build", "search_listing"].includes(row.filter) ? row.filter : "output",
      tool: String(row.tool || "").slice(0, 64),
      original_chars: Number(row.original_chars) || 0,
      capsule_chars: typeof row.capsule_chars === "number" && Number.isFinite(row.capsule_chars)
        ? row.capsule_chars : null,
      elapsed_ms: Number(row.elapsed_ms) || 0,
      requests: Number.isSafeInteger(row.requests) && row.requests >= 0 && row.requests <= 13
        ? row.requests : 0,
      lines_judged: Number.isSafeInteger(row.lines_judged) && row.lines_judged >= 0 ? row.lines_judged : null,
      lines_relevance_judged: Number.isSafeInteger(row.lines_relevance_judged) && row.lines_relevance_judged >= 0
        ? row.lines_relevance_judged : null,
      lines_relevance_kept: Number.isSafeInteger(row.lines_relevance_kept) && row.lines_relevance_kept >= 0
        ? row.lines_relevance_kept : null,
    };
  } catch { return null; }
}

async function readLatestEvent(directory, { informativeOnly = false } = {}) {
  const filename = await activityLogPath(directory);
  let file;
  try {
    file = await fs.open(filename, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 32768);
    if (!length) return null;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= (size > length ? 1 : 0); index -= 1) {
      if (!lines[index].trim()) continue;
      const event = parseLogLine(lines[index]);
      if (event && (!informativeOnly || isInformativeEvent(event))) return event;
    }
    return null;
  } finally {
    await file.close();
  }
}

async function readRecentOutcomes(directory, limit = 3) {
  let file;
  try {
    file = await fs.open(await activityLogPath(directory), "r");
  } catch (error) {
    if (error.code === "ENOENT") return { outcomes: [], offset: 0 };
    throw error;
  }
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 1_048_576);
    if (!length) return { outcomes: [], offset: size };
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    const outcomes = [];
    for (let index = lines.length - 1; index >= (size > length ? 1 : 0) && outcomes.length < limit; index -= 1) {
      const event = parseLogLine(lines[index]);
      if (event && isJevOutcome(event)) outcomes.push(event);
    }
    return { outcomes, offset: size };
  } finally {
    await file.close();
  }
}

async function readEventOffset(directory) {
  try {
    return (await fs.stat(await activityLogPath(directory))).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function readEventsSince(directory, offset) {
  let file;
  try {
    file = await fs.open(await activityLogPath(directory), "r");
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], offset: 0, reset: offset > 0 };
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (offset < 0 || offset > size) return { events: [], offset: size, reset: true };
    const length = Math.min(size - offset, 262_144);
    if (!length) return { events: [], offset, reset: false };
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
    if (end < 0) return { events: [], offset, reset: false };
    const complete = buffer.subarray(0, end + 1);
    const events = complete.toString("utf8").split("\n").map(parseLogLine).filter(Boolean);
    return { events, offset: offset + complete.length, reset: false };
  } finally {
    await file.close();
  }
}

async function readLifetimeStats(directory) {
  const totals = { calls: 0, completed: 0, replaced: 0, savedChars: 0,
    estimatedTokensSaved: 0, averageMs: 0, linesSeen: 0, linesJudged: 0,
    linesKept: 0, linesOmitted: 0, linesProtected: 0, linesUnjudged: 0,
    linesRelevanceJudged: 0, linesBelowOmitCutoff: 0, linesRelevanceKept: 0 };
  const statsFile = path.join(directory, "stats.json");
  try {
    await validateSessionPath(directory);
    const details = await fs.lstat(statsFile);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 8192) throw new Error("Unsafe Jev stats file");
    const stats = JSON.parse(await fs.readFile(statsFile, "utf8"));
    for (const key of ["calls", "completed", "replaced", "timed", "elapsedMs"]) {
      if (!Number.isSafeInteger(stats[key]) || stats[key] < 0) throw new Error("Invalid Jev stats file");
    }
    const savedChars = stats.savedChars ?? 0;
    if (!Number.isSafeInteger(savedChars) || savedChars < 0) throw new Error("Invalid Jev stats file");
    const lineStats = Object.fromEntries(["linesSeen", "linesJudged", "linesKept", "linesOmitted",
      "linesProtected", "linesUnjudged", "linesRelevanceJudged", "linesBelowOmitCutoff", "linesRelevanceKept"].map((key) => {
      const value = stats[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Jev line stats");
      return [key, value];
    }));
    return { calls: stats.calls, completed: stats.completed, replaced: stats.replaced,
      savedChars, estimatedTokensSaved: estimateTokensSaved(savedChars),
      averageMs: stats.timed ? Math.round(stats.elapsedMs / stats.timed) : 0, ...lineStats };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const filename = await activityLogPath(directory);
  let file;
  try {
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Unsafe Jev decision log");
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === "ENOENT") return totals;
    throw error;
  }
  let timed = 0;
  let elapsedMs = 0;
  const lines = readline.createInterface({ input: file.createReadStream({ encoding: "utf8", autoClose: false }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 8192) continue;
      const event = parseLogLine(line);
      if (!event) continue;
      if (event.status === "calling") totals.calls += 1;
      else totals.calls += event.requests;
      if (!isJevOutcome(event)) continue;
      totals.completed += 1;
      if (event.status === "replace") totals.replaced += 1;
      totals.savedChars += savedCharacters(event);
      if (Number.isFinite(event.elapsed_ms) && event.elapsed_ms > 0) {
        timed += 1;
        elapsedMs += event.elapsed_ms;
      }
    }
  } finally {
    lines.close();
    await file.close();
  }
  totals.estimatedTokensSaved = estimateTokensSaved(totals.savedChars);
  totals.averageMs = timed ? Math.round(elapsedMs / timed) : 0;
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
  const source = event.filter === "test_build" ? "test/build" :
    event.filter === "search_listing" ? "search/listing" : (event.tool || "tool");
  const rated = event.filter === "search_listing" && event.lines_relevance_judged !== null &&
    event.lines_relevance_judged !== undefined ? ` · ${event.lines_relevance_judged} search lines rated` : "";
  return `${action}${mode} · ${source} · ${event.original_chars.toLocaleString()} chars${rated}${saved}`;
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

function formatDuration(elapsedMs) {
  const milliseconds = Math.max(0, Number(elapsedMs) || 0);
  return milliseconds >= 1000
    ? `${(Math.floor(milliseconds / 100) / 10).toFixed(1).replace(".", ",")}s`
    : `${Math.round(milliseconds)} ms`;
}

function activitySummary(stats) {
  const replaced = Number(stats.replaced) || 0;
  const completed = Number(stats.completed) || 0;
  const average = completed ? formatDuration((Number(stats.elapsedMs) || 0) / completed) : "—";
  return `${completed} checked · ${replaced} replaced · ${average} avg`;
}

function decisionSummary(event) {
  if (!event) return "No hook decision recorded yet";
  if (event.status === "calling") return `Checking ${event.tool || "tool"} output with Jev`;
  const action = event.status === "replace" ? "replaced" :
    event.status === "candidate" ? "candidate" :
    event.status === "keep" ? "kept" : "skipped";
  const source = event.filter === "test_build" ? "test/build " :
    event.filter === "search_listing" ? "search/listing " : "";
  return `Last decision: ${action} ${source}${event.tool || "tool"} output (${event.reason}); ${event.original_chars.toLocaleString()} chars`;
}

function parseHealthOutput(stdout) {
  const result = JSON.parse(stdout);
  const answer = result.answers?.ready;
  if (typeof result.model !== "string" || answer?.type !== "noul" ||
      typeof answer.noul !== "number" || answer.noul < 0 || answer.noul > 1) {
    throw new Error("Invalid Jev health result");
  }
  return { ok: true, model: result.model };
}

async function readApiKey(directory) {
  const filename = path.join(directory, ".env");
  const details = await fs.lstat(filename);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 8192 ||
      (process.platform !== "win32" && (details.mode & 0o077))) throw new Error("Unsafe Jev credential file");
  const lines = (await fs.readFile(filename, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/);
  const values = lines.filter((line) => /^\s*JEV_API_KEY\s*=/.test(line)).map((line) => {
    let value = line.slice(line.indexOf("=") + 1).trim();
    if (value.length >= 2 && ["'", '"'].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
    return value;
  });
  if (values.length !== 1 || values[0].length < 8 || values[0].length > 4096 || /\s|\0/.test(values[0])) {
    throw new Error("Jev API key is missing or invalid");
  }
  return values[0];
}

async function checkHealth(dataDirectory, send = globalThis.fetch, suppliedKey = null) {
  let key;
  try {
    key = suppliedKey === null ? await readApiKey(dataDirectory) : validateApiKey(suppliedKey);
  } catch {
    return { ok: false, reason: "JEV_KEY_MISSING" };
  }
  const body = JSON.stringify({
    state: { output_sample: "Compiling module 1 done\nCompiling module 2 done" },
    model: "jev-1.13.0",
    questions: { ready: { type: "noul", instructions: "Is output_sample routine build progress?" } },
  });
  let response;
  try {
    response = await send(JEV_ENDPOINT, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(6000),
    });
  } catch (error) {
    return { ok: false, reason: ["AbortError", "TimeoutError"].includes(error?.name)
      ? "JEV_TIMEOUT" : "JEV_NETWORK_ERROR" };
  }
  if (!response || typeof response.ok !== "boolean") {
    return { ok: false, reason: "JEV_INVALID_RESPONSE" };
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status) && typeof response.text === "function") {
      try {
        const error = JSON.parse((await response.text()).slice(0, 4096));
        const details = [error.code, error.message, error.error?.code, error.error?.message];
        if (details.some((value) => typeof value === "string" && /expir/i.test(value))) {
          return { ok: false, reason: "JEV_KEY_EXPIRED" };
        }
      } catch { /* An unstructured error keeps its HTTP status. */ }
    }
    return { ok: false, reason: `JEV_HTTP_${response.status}` };
  }
  try {
    const output = await response.text();
    if (output.length > 262144) throw new Error("Jev health response is too large");
    return parseHealthOutput(output);
  } catch {
    return { ok: false, reason: "JEV_INVALID_RESPONSE" };
  }
}

function validateApiKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 4096 || /\s|\0/.test(key)) {
    throw new Error("Jev API key is missing or invalid");
  }
  return key;
}

async function writeApiKey(directory, key) {
  validateApiKey(key);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) {
    throw new Error("Unsafe plugin data directory");
  }
  const target = path.join(directory, ".env");
  let lines = [];
  try {
    const details = await fs.lstat(target);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 8192 ||
        (process.platform !== "win32" && (details.mode & 0o077))) throw new Error("Unsafe Jev credential file");
    lines = (await fs.readFile(target, "utf8")).split(/\r?\n/)
      .filter((line) => !/^\s*JEV_API_KEY\s*=/.test(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const content = [...lines.filter(Boolean), `JEV_API_KEY=${key}`].join("\n") + "\n";
  if (Buffer.byteLength(content) > 8192) throw new Error("Jev credential file is too large");
  const temporary = path.join(directory, `.env-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    if (process.platform === "win32") {
      const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([A-Za-z0-9_-]+)\\(.+)$/i.exec(temporary);
      if (match) await runFile("wsl.exe", ["-d", match[1], "-e", "chmod", "600", `/${match[2].replaceAll("\\", "/")}`]);
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

module.exports = {
  activitySummary, checkHealth, sessionDirectory, validateSessionPath, readHookHealth,
  completeLinePolicy, DEFAULT_LINE_POLICY,
  completeSearchRelevance, DEFAULT_SEARCH_RELEVANCE,
  decisionSummary, defaultDataDirectory, estimateTokensSaved, formatDuration,
  isInformativeEvent, isJevOutcome, outcomeLine, parseHealthOutput, readConfig,
  readApiKey, readEventOffset, readEventsSince, readLatestEvent, readLifetimeStats, readRecentOutcomes,
  savedCharacters, writeApiKey, writeEnabled, writeMode, writeSelection,
  writeSettings, writeNeverDeleteLogs, ensureSessionDefaults,
};
