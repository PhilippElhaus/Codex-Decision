"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const readline = require("node:readline");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const { restrictWslPath, wslLocation } = require("./private-paths");
const securedWslPaths = new Map();
const { provider, wireRequest, parseHealthResult } = require("./providers");
const { defaults, validate } = require("./schema");
const DEFAULT_RELEVANCE_POLICY = Object.freeze(defaults("config").relevance_policy);
const { schema_version: _schemaVersion, ...settingsDefaults } = defaults("settings");
const DEFAULT_SETTINGS = Object.freeze(settingsDefaults);
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

// Inspect every directory component, including roots and logs, before accessing state.
async function validateDirectoryPath(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let details;
    try { details = await fs.lstat(current); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("Unsafe Decision session directory path");
    }
  }
}

async function validateSessionPath(directory) {
  await validateDirectoryPath(directory);
  const parent = path.dirname(directory);
  const folders = path.basename(parent) === "sessions" ? [path.dirname(parent), parent, directory] : [directory];
  for (const folder of folders) {
    let details;
    try { details = await fs.lstat(folder); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (process.platform !== "win32" && (details.mode & 0o077)) {
      throw new Error("Unsafe Decision session directory permissions");
    }
  }
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
  try {
    await validateSessionPath(directory);
    await validateDirectoryPath(path.join(directory, "logs"));
    const logs = await fs.lstat(path.dirname(filename));
    if (!logs.isDirectory() || logs.isSymbolicLink()) throw new Error("Unsafe Decision hook health directory");
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 4096) throw new Error("Unsafe Decision hook health");
    const health = JSON.parse(await fs.readFile(filename, "utf8"));
    if (!health || health.version !== 1 || typeof health.hook_version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(health.hook_version) ||
        !Number.isSafeInteger(health.last_seen_ms) || health.last_seen_ms <= 0 ||
        health.last_seen_ms > Date.now() + 300_000 ||
        (health.skipped !== undefined && (!Number.isSafeInteger(health.skipped) || health.skipped < 0)) ||
        (health.api_requests !== undefined && (!Number.isSafeInteger(health.api_requests) || health.api_requests < 0)) ||
        ["last_success_ms", "last_error_ms", "last_skip_ms"].some((key) =>
          health[key] !== undefined && (!Number.isSafeInteger(health[key]) || health[key] < 0 ||
            health[key] > health.last_seen_ms)) ||
        ["last_error", "last_skip"].some((key) =>
          health[key] !== undefined && (typeof health[key] !== "string" || health[key].length > 80))) {
      throw new Error("Invalid Decision hook health");
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
      throw new Error("Unsafe Decision config");
    }
    const raw = JSON.parse(await fs.readFile(filename, "utf8"));
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
    const raw = JSON.parse(await fs.readFile(filename, "utf8"));
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
  const totals = await readLifetimeStats(directory);
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
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe Decision session directory");
    const stats = await readLifetimeStats(path.join(directory, "sessions", entry.name));
    for (const key of Object.keys(totals)) {
      if (key === "averageMs") continue;
      totals[key] += stats[key];
    }
  }
  totals.averageMs = totals.timed ? Math.round(totals.elapsedMs / totals.timed) : 0;
  return totals;
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
  try {
    return (await fs.stat(await activityLogPath(directory))).size;
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
  let file;
  try {
    file = await fs.open(await activityLogPath(directory), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    return await eventCursor(file, (await file.stat()).size);
  } catch (error) {
    if (error.code === "ENOENT") return { offset: 0, identity: null, anchor: "" };
    throw error;
  } finally { await file?.close(); }
}

async function readEventsSince(directory, position) {
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
    const { size } = details;
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
  const totals = { calls: 0, completed: 0, replaced: 0, savedChars: 0,
    estimatedTokensSaved: 0, averageMs: 0, timed: 0, elapsedMs: 0, linesSeen: 0, linesJudged: 0,
    linesKept: 0, linesOmitted: 0, linesProtected: 0, linesUnjudged: 0,
    linesRelevanceJudged: 0, linesBelowOmitCutoff: 0, linesRelevanceKept: 0 };
  const statsFile = path.join(directory, "stats.json");
  try {
    await validateSessionPath(directory);
    const details = await fs.lstat(statsFile);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 8192) throw new Error("Unsafe Decision stats file");
    const stats = JSON.parse(await fs.readFile(statsFile, "utf8"));
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
      averageMs: stats.timed ? Math.round(stats.elapsedMs / stats.timed) : 0, timed: stats.timed, elapsedMs: stats.elapsedMs, ...lineStats };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const filename = await activityLogPath(directory);
  let file;
  try {
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Unsafe Decision decision log");
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
      if ((isDecisionOutcome(event) || event.reason === "choice_kept_full_output") &&
          Number.isFinite(event.elapsed_ms) && event.elapsed_ms > 0) {
        // Legacy calling/outcome pairs represent one request. Current completion
        // events contain the total elapsed time for all requests in the result.
        timed += event.requests || 1;
        elapsedMs += event.elapsed_ms;
      }
      if (!isDecisionOutcome(event)) continue;
      totals.completed += 1;
      if (event.status === "replace") totals.replaced += 1;
      totals.savedChars += savedCharacters(event);
    }
  } finally {
    lines.close();
    await file.close();
  }
  totals.estimatedTokensSaved = estimateTokensSaved(totals.savedChars);
  totals.timed = timed; totals.elapsedMs = elapsedMs;
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
      body, signal: AbortSignal.timeout(6000),
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
  savedCharacters, writeApiKey, writeSelection,
  ensureSessionDefaults,
  DEFAULT_SETTINGS, readGlobalSettings, writeGlobalSettings, readInstallationStats,
};
