"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_THRESHOLDS = Object.freeze({
  output: { routine_min: 90, exact_max: 12, unique_max: 10 },
  test_build: { routine_min: 90, exact_max: 20, unique_max: 20 },
  search_listing: { summarize_probability_min: 78, summarize_confidence_min: 70,
    drop_probability_min: 92, drop_confidence_min: 85 },
});
const CONFIG_KEYS = new Set([
  "enabled", "test_build_enabled", "search_listing_enabled", "precompact_enabled", "mode", "min_chars", "max_chars", "sample_chars",
  "timeout_seconds", "model", "allow_mcp_replacement", "thresholds",
]);

function completeThresholds(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((hook) => !Object.hasOwn(DEFAULT_THRESHOLDS, hook))) throw new Error("Invalid Jev thresholds");
  const result = {};
  for (const [hook, defaults] of Object.entries(DEFAULT_THRESHOLDS)) {
    const entered = value[hook] === undefined ? {} : value[hook];
    if (typeof entered !== "object" || Array.isArray(entered) ||
        Object.keys(entered).some((name) => !Object.hasOwn(defaults, name))) throw new Error("Invalid Jev thresholds");
    result[hook] = { ...defaults, ...entered };
    if (Object.values(result[hook]).some((number) => !Number.isInteger(number) || number < 0 || number > 100)) {
      throw new Error("Jev thresholds must be whole percentages from 0 to 100");
    }
  }
  return result;
}

function defaultDataDirectory() {
  return process.env.CODEX_JEV_DATA_DIRECTORY || "";
}

async function readConfig(directory) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8"));
    const merged = {
      enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace", min_chars: 8192, max_chars: 2_000_000,
      sample_chars: 12_000, timeout_seconds: 3, model: "jev-1.13.0",
      allow_mcp_replacement: false, ...raw,
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).some((key) => !CONFIG_KEYS.has(key)) ||
        typeof merged.enabled !== "boolean" || typeof merged.test_build_enabled !== "boolean" ||
        typeof merged.search_listing_enabled !== "boolean" ||
        (raw.precompact_enabled !== undefined && typeof raw.precompact_enabled !== "boolean") ||
        !["observe", "replace"].includes(merged.mode) ||
        !Number.isInteger(merged.min_chars) || !Number.isInteger(merged.max_chars) ||
        merged.min_chars < 1024 || merged.min_chars > merged.max_chars || merged.max_chars > 2_000_000 ||
        !Number.isInteger(merged.sample_chars) || merged.sample_chars < 1000 || merged.sample_chars > 24_000 ||
        typeof merged.timeout_seconds !== "number" || merged.timeout_seconds < 0.1 || merged.timeout_seconds > 4 ||
        typeof merged.model !== "string" || !/^jev-[\w.-]{1,40}$/.test(merged.model) ||
        typeof merged.allow_mcp_replacement !== "boolean") {
      throw new Error("Invalid Jev config");
    }
    completeThresholds(merged.thresholds);
    const { precompact_enabled: _legacy, ...current } = raw;
    return { enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace", ...current };
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, test_build_enabled: false, search_listing_enabled: false, mode: "replace" };
    throw error;
  }
}

async function writeConfig(directory, updates) {
  const config = { ...await readConfig(directory), ...updates };
  completeThresholds(config.thresholds);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Plugin data directory is a link");
  const target = path.join(directory, "config.json");
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Jev config is a link");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
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

async function writeThresholds(directory, thresholds) {
  return writeConfig(directory, { thresholds: completeThresholds(thresholds) });
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
    };
  } catch { return null; }
}

async function readLatestEvent(directory, { informativeOnly = false } = {}) {
  const filename = path.join(directory, "events.jsonl");
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
    file = await fs.open(path.join(directory, "events.jsonl"), "r");
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
    return (await fs.stat(path.join(directory, "events.jsonl"))).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function readEventsSince(directory, offset) {
  let file;
  try {
    file = await fs.open(path.join(directory, "events.jsonl"), "r");
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

function outcomeLine(event) {
  const action = event.status === "replace" ? "replaced" :
    event.status === "candidate" ? "candidate" : "kept";
  const mode = event.reason === "observe" ? " (observe)" : "";
  const savedChars = savedCharacters(event);
  const saved = savedChars > 0
    ? ` · -${Math.round(100 * savedChars / event.original_chars)}%`
    : "";
  const source = event.filter === "test_build" ? "test/build" :
    event.filter === "search_listing" ? "search/listing" : (event.tool || "tool");
  return `${action}${mode} · ${source} · ${event.original_chars.toLocaleString()} chars${saved}`;
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
  if (!response.ok) return { ok: false, reason: `JEV_HTTP_${response.status}` };
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
  activitySummary, checkHealth, completeThresholds, DEFAULT_THRESHOLDS, decisionSummary, defaultDataDirectory, estimateTokensSaved, formatDuration,
  isInformativeEvent, isJevOutcome, outcomeLine, parseHealthOutput, readConfig,
  readApiKey, readEventOffset, readEventsSince, readLatestEvent, readRecentOutcomes,
  savedCharacters, writeApiKey, writeEnabled, writeMode, writeSelection, writeThresholds,
};
