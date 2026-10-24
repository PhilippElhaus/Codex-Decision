"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { wslLocation } = require("./private-paths");

const TAIL_BYTES = 256 * 1024;
const SEARCH_ENTRIES = 20_000;
const CACHE_ENTRIES = 64;
const rolloutPaths = new Map();

function sessionWorkDirectory({ dataDirectory = "", codexHome = process.env.CODEX_HOME,
  platform = process.platform, home = os.homedir() } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const location = wslLocation(dataDirectory);
  let root;
  if (typeof codexHome === "string" && codexHome) {
    if (platform === "win32") {
      const homeLocation = wslLocation(codexHome);
      if (location && /^\/(?!\/)/.test(codexHome)) {
        root = `\\\\wsl.localhost\\${location.distro}${codexHome.replaceAll("/", "\\")}`;
      } else if ((location && homeLocation?.distro.toLowerCase() === location.distro.toLowerCase()) ||
          (!location && /^[A-Za-z]:[\\/]/.test(codexHome))) root = codexHome;
    } else if (paths.isAbsolute(codexHome)) root = codexHome;
  }
  if (!root && typeof dataDirectory === "string") {
    const separator = platform === "win32" ? "\\" : "/";
    const match = /^(.*)[\\/]plugins[\\/]data[\\/][^\\/]+[\\/]?$/.exec(dataDirectory);
    if (match && paths.isAbsolute(match[1])) root = match[1];
    else if (platform === "win32" && location) {
      const linuxHome = /^(\/home\/[^/]+|\/root)(?:\/|$)/.exec(location.filename)?.[1];
      if (linuxHome) root = `\\\\wsl.localhost\\${location.distro}${linuxHome.replaceAll("/", separator)}\\.codex`;
    }
  }
  if (!root && (!location || platform !== "win32") && paths.isAbsolute(home)) root = paths.join(home, ".codex");
  if (!root || /[\r\n\0]/.test(root)) return null;
  return paths.join(root, "sessions");
}

async function plainDirectory(directory) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const details = await fs.lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Unsafe Codex session path");
  }
}

async function findRollout(root, sessionId) {
  // Only filenames identify the session. Forked logs can retain a parent's metadata.
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = new RegExp(`^rollout-(?:\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-)?${escaped}\\.jsonl$`);
  let remaining = SEARCH_ENTRIES;
  let found = null;
  async function visit(directory, depth) {
    await plainDirectory(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    remaining -= entries.length;
    if (remaining < 0) throw new Error("Codex session search limit exceeded");
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isFile() && name.test(entry.name)) {
        if (found) throw new Error("Ambiguous Codex session rollout");
        found = filename;
      } else if (entry.isDirectory() && depth < 3 &&
          (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        await visit(filename, depth + 1);
      }
    }
  }
  await visit(root, 0);
  return found;
}

function tailWorkComplete(bytes, clipped = false) {
  // A writer can be in the middle of a new turn. Never use a partial last row.
  if (!bytes.length || bytes.at(-1) !== 10) return false;
  let source = bytes.toString("utf8");
  if (clipped) source = source.slice(source.indexOf("\n") + 1);
  const lines = source.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue;
    let record;
    try { record = JSON.parse(lines[index]); } catch { return false; }
    if (!record || typeof record !== "object") return false;
    if (record.type === "turn_context") return false;
    const payload = record.payload;
    if (record.type === "event_msg") {
      if (payload?.type === "task_complete") return true;
      if (["task_started", "user_message", "turn_aborted"].includes(payload?.type)) return false;
    }
    if (record.type === "response_item" && (["function_call", "custom_tool_call",
      "function_call_output", "custom_tool_call_output"].includes(payload?.type) ||
      payload?.type === "message" && payload.role === "user")) return false;
  }
  return false;
}

async function readCompletion(filename) {
  await plainDirectory(path.dirname(filename));
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) return false;
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) |
    (constants.O_NONBLOCK || 0));
  try {
    const details = await file.stat();
    if (!details.isFile() || details.dev !== before.dev || details.ino !== before.ino ||
        !Number.isSafeInteger(details.size)) return false;
    const length = Math.min(details.size, TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(bytes, offset, length - offset, details.size - length + offset);
      if (!bytesRead) return false;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (details.size !== after.size || details.mtimeMs !== after.mtimeMs || details.ctimeMs !== after.ctimeMs) return false;
    return tailWorkComplete(bytes, details.size > length);
  } finally { await file.close(); }
}

async function readSessionWorkComplete(sessionId, options = {}) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) return false;
  const root = options.sessionsDirectory || sessionWorkDirectory(options);
  if (!root || !path.isAbsolute(root)) return false;
  const key = `${root}\0${sessionId}`;
  try {
    let filename = rolloutPaths.get(key);
    if (!filename) {
      filename = await findRollout(root, sessionId);
      if (!filename) return false;
      if (rolloutPaths.size >= CACHE_ENTRIES) rolloutPaths.delete(rolloutPaths.keys().next().value);
      rolloutPaths.set(key, filename);
    }
    return await readCompletion(filename);
  } catch {
    rolloutPaths.delete(key);
    return false;
  }
}

module.exports = { readSessionWorkComplete, sessionWorkDirectory };
