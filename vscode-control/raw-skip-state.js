"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { readFileRecord, parseUniqueJson, validateSessionPath, validateDirectoryPath } = require("./private-records");
const { restrictWslPath } = require("./private-paths");

const MAX_RAW_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_ENTRIES = 20;
const FLAG_NAME = "skipped-raw-enabled.json";

function parseRawSkips(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new Error("Invalid Decision skipped payloads");
  }
  return value.entries.map(entry => {
    if (!entry || !/^[a-f0-9]{32}$/.test(entry.id) || typeof entry.at !== "string" ||
        !Number.isFinite(Date.parse(entry.at)) || !/^[a-z0-9_]{1,80}$/.test(entry.reason) ||
        typeof entry.tool_name !== "string" || Array.from(entry.tool_name).length > 256 ||
        (entry.tool_use_id !== null && (typeof entry.tool_use_id !== "string" || Array.from(entry.tool_use_id).length > 128)) ||
        (entry.detail !== null && !["protected_output", "protected_command", "protected_input"].includes(entry.detail)) ||
        (entry.payload_unavailable !== null && entry.payload_unavailable !== "size_limit") ||
        (entry.payload_unavailable === null ? !entry.payload || typeof entry.payload !== "object" ||
          Array.isArray(entry.payload) || typeof entry.payload.tool_input_json !== "string" ||
          typeof entry.payload.tool_response_json !== "string" || Buffer.byteLength(JSON.stringify(entry.payload)) > MAX_PAYLOAD_BYTES :
          entry.payload !== null)) throw new Error("Invalid Decision skipped payload");
    return { id: entry.id, at: entry.at, reason: entry.reason, detail: entry.detail,
      tool_name: entry.tool_name, tool_use_id: entry.tool_use_id,
      payload: entry.payload, payload_unavailable: entry.payload_unavailable };
  });
}

async function readRawSkipState(directory, cache = null) {
  await validateSessionPath(directory);
  const logs = path.join(directory, "logs");
  await validateDirectoryPath(logs);
  const flag = await readFileRecord(path.join(logs, FLAG_NAME), 256, { strict: true });
  if (!flag) { if (cache) { cache.identity = null; cache.entries = []; } return { enabled: false, entries: [] }; }
  const value = parseUniqueJson(flag.bytes);
  if (value?.version !== 1 || typeof value.enabled !== "boolean" || Object.keys(value).length !== 2) {
    throw new Error("Invalid Decision skipped payload preference");
  }
  // An unchecked panel never reads tool text into the extension host or webview.
  if (!value.enabled) { if (cache) { cache.identity = null; cache.entries = []; } return { enabled: false, entries: [] }; }
  try {
    const filename = path.join(logs, "skipped-raw.json");
    const details = await fs.lstat(filename).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (!details) return { enabled: true, entries: [] };
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || details.size > MAX_RAW_BYTES ||
        process.platform !== "win32" && (details.uid !== process.getuid() || details.mode & 0o077)) {
      throw new Error("Unsafe Decision skipped payload file");
    }
    const identity = `${details.dev}:${details.ino}:${details.mtimeMs}:${details.ctimeMs}:${details.size}`;
    if (cache?.identity === identity) return { enabled: true, entries: cache.entries };
    const record = await readFileRecord(filename, MAX_RAW_BYTES, { strict: true });
    const entries = record ? parseRawSkips(parseUniqueJson(record.bytes)) : [];
    if (cache) { cache.identity = identity; cache.entries = entries; }
    return { enabled: true, entries };
  } catch (error) {
    // A broken payload file must still leave the checked control usable to stop capture.
    error.rawCaptureEnabled = true;
    throw error;
  }
}

async function writeRawSkipPreference(directory, enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("Invalid Decision skipped payload preference");
  await validateSessionPath(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await restrictWslPath(directory, true);
  await validateSessionPath(directory);
  const logs = path.join(directory, "logs");
  await validateDirectoryPath(logs);
  await fs.mkdir(logs, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await restrictWslPath(logs, true);
  await validateDirectoryPath(logs);
  const target = path.join(logs, FLAG_NAME);
  // Reject links and non-private existing records before replacing them.
  await readFileRecord(target, 256, { strict: true });
  const temporary = path.join(logs, `.jev-${crypto.randomUUID()}.tmp`);
  let owned = false;
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    owned = true;
    try { await file.writeFile(JSON.stringify({ version: 1, enabled }) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await restrictWslPath(temporary, false);
    await fs.rename(temporary, target);
  } finally { if (owned) await fs.rm(temporary, { force: true }); }
}

module.exports = { readRawSkipState, writeRawSkipPreference, parseRawSkips, MAX_RAW_BYTES, MAX_PAYLOAD_BYTES, MAX_ENTRIES };
