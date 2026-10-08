"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const STATS_ACTIVITY_KEYS = ["calls", "completed", "replaced", "timed", "elapsedMs", "savedChars",
  "candidates", "kept", "linesSeen", "linesJudged", "linesKept", "linesOmitted", "linesProtected",
  "linesUnjudged", "linesRelevanceJudged", "linesBelowOmitCutoff", "linesRelevanceKept", "linesActuallyOmitted"];

async function validateDirectoryPath(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,part);
    let details;
    try {details = await fs.lstat(current);} catch(error) {if (error.code === "ENOENT") return;throw error;}
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Unsafe Decision session directory path");
  }
}

async function validateSessionPath(directory) {
  await validateDirectoryPath(directory);
  const parent = path.dirname(directory);
  const folders = path.basename(parent) === "sessions" ? [path.dirname(parent),parent,directory] : [directory];
  for (const folder of folders) {
    let details;
    try {details = await fs.lstat(folder);} catch(error) {if (error.code === "ENOENT") return;throw error;}
    if (process.platform !== "win32" && details.mode & 0o077) throw new Error("Unsafe Decision session directory permissions");
  }
}

// A single opened handle supplies the bytes and identity. Journals and their
// backups additionally require the writer's private, singly linked inode.
async function readFileRecord(filename, limit, { strict = false, range = null } = {}) {
  if (!path.isAbsolute(filename) || !Number.isSafeInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024) {
    throw new Error("Invalid Decision record scope");
  }
  if (range && (!Number.isSafeInteger(range.position) || range.position < 0 ||
      !Number.isSafeInteger(range.length) || range.length < 0 || range.length > limit ||
      !Number.isSafeInteger(range.position + range.length))) throw new Error("Invalid Decision record range");
  let file;
  try {
    const check = details => {
      if (!details.isFile() || details.isSymbolicLink?.() || !range && details.size > limit ||
          strict && (details.nlink !== 1 || process.platform !== "win32" &&
            (details.uid !== process.getuid() || details.mode & 0o077))) throw new Error("Unsafe Decision private record");
    };
    check(await fs.lstat(filename));
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const details = await file.stat(); check(details);
    const bytes = Buffer.alloc(range ? range.length : limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, (range?.position || 0) + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!range && length > limit) throw new Error("Unsafe Decision private record");
    return { bytes: bytes.subarray(0, length), size:details.size,
      fingerprint: `${filename}:${details.dev}:${details.ino}:${details.mtimeMs}:${details.ctimeMs}:${details.size}` };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { await file?.close(); }
}

function parseUniqueJson(source) {
  if (Buffer.isBuffer(source)) source = new TextDecoder("utf-8", {fatal:true,ignoreBOM:true}).decode(source);
  const value = JSON.parse(source, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid Decision JSON number");
    if (typeof value === "string" && !wellFormedString(value)) throw new Error("Invalid Decision JSON Unicode string");
    return value;
  });
  const stack = [];
  for (const token of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g)) {
    const text = token[0];
    if (text === "{") stack.push({ keys: new Set(), key: true });
    else if (text === "[") stack.push(null);
    else if (text === "}" || text === "]") stack.pop();
    else if (text === ",") { if (stack.at(-1)) stack.at(-1).key = true; }
    else if (text[0] === '"' && stack.at(-1)?.key) {
      const current = stack.at(-1), name = JSON.parse(text);
      if (!wellFormedString(name)) throw new Error("Invalid Decision JSON Unicode key");
      if (current.keys.has(name)) throw new Error("Duplicate Decision counter field");
      current.keys.add(name); current.key = false;
    }
  }
  return value;
}

function wellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (point >= 0xdc00 && point <= 0xdfff) return false;
  }
  return true;
}

function validateStatsRecord(recorded) {
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded) ||
      Object.keys(recorded).length > 128 || Object.values(recorded).some(count =>
        !Number.isSafeInteger(count) || count < 0)) throw new Error("Invalid Decision stats file");
  if (recorded.counter_scheme !== undefined && recorded.counter_scheme !== 1) throw new Error("Unsupported Decision counter scheme");
  if (Object.entries(recorded).some(([key, value]) => key.startsWith("partial_") &&
      (!STATS_ACTIVITY_KEYS.includes(key.slice(8)) || value > 1))) throw new Error("Invalid Decision counter coverage");
  return recorded;
}

// Persisted unsigned counters use decimal integer tokens, matching Rust u64.
// This is separate from generic JSON: panel probabilities remain floating point.
function parseUnsignedJson(source, unsignedPath, safeIntegerPath = () => false) {
  if (Buffer.isBuffer(source)) source = new TextDecoder("utf-8", {fatal:true,ignoreBOM:true}).decode(source);
  const value = parseUniqueJson(source), stack = [];
  for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[{}\[\],:]/g)) {
    const token = match[0], parent = stack.at(-1);
    if (token === "{" || token === "[") {
      stack.push({path:parent ? [...parent.path,parent.array ? "*" : parent.name] : [],array:token === "[",key:true});
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") {if (parent && !parent.array) parent.key = true;}
    else if (token[0] === '"') {
      if (parent && !parent.array && parent.key) {parent.name = JSON.parse(token);parent.key = false;}
    } else if (token !== ":") {
      const keys=parent ? [...parent.path,parent.array ? "*" : parent.name] : [];
      if (unsignedPath(keys)) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(token) || BigInt(token)>18_446_744_073_709_551_615n) throw new Error("Invalid Decision unsigned counter token");
        if (safeIntegerPath(keys) && BigInt(token)>BigInt(Number.MAX_SAFE_INTEGER)) {
          const error=new Error("Decision retained activity exceeds the exact numeric range");error.code="DECISION_COUNTER_RANGE";throw error;
        }
      }
    }
  }
  return value;
}

module.exports = { readFileRecord, parseUniqueJson, parseUnsignedJson, validateStatsRecord, STATS_ACTIVITY_KEYS, validateDirectoryPath, validateSessionPath };
