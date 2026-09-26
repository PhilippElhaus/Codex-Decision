"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const CONFIG_KEYS = new Set([
  "enabled", "mode", "min_chars", "max_chars", "sample_chars",
  "timeout_seconds", "model", "allow_mcp_replacement",
]);

function defaultDataDirectory() {
  return path.resolve(__dirname, "..", ".local");
}

function defaultCredentialDirectory() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Codex", "jev-output-pilot");
}

async function readConfig(directory) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8"));
    const merged = {
      enabled: false, mode: "observe", min_chars: 8192, max_chars: 2_000_000,
      sample_chars: 12_000, timeout_seconds: 3, model: "jev-1.13.0",
      allow_mcp_replacement: false, ...raw,
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).some((key) => !CONFIG_KEYS.has(key)) ||
        typeof merged.enabled !== "boolean" ||
        !["observe", "replace"].includes(merged.mode) ||
        !Number.isInteger(merged.min_chars) || !Number.isInteger(merged.max_chars) ||
        merged.min_chars < 1024 || merged.min_chars > merged.max_chars || merged.max_chars > 2_000_000 ||
        !Number.isInteger(merged.sample_chars) || merged.sample_chars < 1000 || merged.sample_chars > 24_000 ||
        typeof merged.timeout_seconds !== "number" || merged.timeout_seconds < 0.1 || merged.timeout_seconds > 4 ||
        typeof merged.model !== "string" || !/^jev-[\w.-]{1,40}$/.test(merged.model) ||
        typeof merged.allow_mcp_replacement !== "boolean") {
      throw new Error("Invalid pilot config");
    }
    return { enabled: false, mode: "observe", ...raw };
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, mode: "observe" };
    throw error;
  }
}

async function writeEnabled(directory, enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  const config = { ...await readConfig(directory), enabled };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Plugin data directory is a link");
  const target = path.join(directory, "config.json");
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Pilot config is a link");
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

function isInformativeEvent(event) {
  return event.status !== "calling" &&
    !(event.status === "skip" && ["small", "unsupported_event", "unsupported_result"].includes(event.reason));
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
      try {
        const row = JSON.parse(lines[index]);
        if (row && typeof row.status === "string" && typeof row.reason === "string") {
          const event = {
            status: row.status.slice(0, 32), reason: row.reason.slice(0, 64),
            tool: String(row.tool || "").slice(0, 64),
            original_chars: Number(row.original_chars) || 0,
            elapsed_ms: Number(row.elapsed_ms) || 0,
          };
          if (!informativeOnly || isInformativeEvent(event)) return event;
        }
      } catch { /* Skip a partial or malformed final line. */ }
    }
    return null;
  } finally {
    await file.close();
  }
}

function decisionSummary(event) {
  if (!event) return "No hook decision recorded yet";
  if (event.status === "calling") return `Checking ${event.tool || "tool"} output with Jev`;
  const action = event.status === "replace" ? "replaced" :
    event.status === "candidate" ? "candidate" :
    event.status === "keep" ? "kept" : "skipped";
  return `Last decision: ${action} ${event.tool || "tool"} output (${event.reason}); ${event.original_chars.toLocaleString()} chars, ${event.elapsed_ms} ms`;
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

function runCommand(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = { stdout: [], stderr: [] };
    let size = 0;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (chunk) => {
        size += chunk.length;
        if (size > 262144) child.kill();
        else chunks[stream].push(chunk);
      });
    }
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function checkHealth(credentialDirectory, execute = runCommand) {
  const script = path.join(credentialDirectory, "invoke_jev.ps1");
  const refresh = path.join(credentialDirectory, "refresh_key_cache.ps1");
  const request = Buffer.from(JSON.stringify({
    state: { output_sample: "Compiling module 1 done\nCompiling module 2 done" },
    model: "jev-1.13.0",
    questions: { ready: { type: "noul", instructions: "Is output_sample routine build progress?" } },
  })).toString("base64") + "\n";
  async function probe() {
    return execute("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", script], request, 6000);
  }
  try {
    let result = await probe();
    const reason = result.stderr.match(/\bJEV_[A-Z0-9_]+\b/)?.[0];
    if (result.exitCode !== 0 && ["JEV_HTTP_401", "JEV_HTTP_403", "JEV_KEY_CACHE_MISSING", "JEV_API_KEY_INVALID"].includes(reason)) {
      const update = await execute("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", refresh], "", 75_000);
      if (update.exitCode === 0) result = await probe();
    }
    if (result.exitCode !== 0) return { ok: false, reason: result.stderr.match(/\bJEV_[A-Z0-9_]+\b/)?.[0] || "JEV_UNAVAILABLE" };
    const { stdout } = result;
    return parseHealthOutput(stdout);
  } catch {
    return { ok: false, reason: "JEV_UNAVAILABLE" };
  }
}

module.exports = {
  checkHealth, decisionSummary, defaultCredentialDirectory, defaultDataDirectory,
  isInformativeEvent, parseHealthOutput, readConfig, readLatestEvent, writeEnabled,
};
