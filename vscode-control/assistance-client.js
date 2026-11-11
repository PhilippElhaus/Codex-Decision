"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { wslLocation } = require("./private-paths");
const { validateDirectoryPath, parseUniqueJson } = require("./private-records");

// Never invoke a shell or put evidence/credentials in process arguments.
function runProcess(command, args, { env = process.env, input = "", timeout = 20_000,
  signal, launch = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", size = 0, settled = false;
    const done = error => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) { child.kill(); reject(new Error(error)); } else resolve(output);
    };
    const abort = () => done("Decision assistance was cancelled");
    const timer = setTimeout(() => done("Decision assistance timed out"), timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) done("Decision assistance response exceeded its limit");
      else output += chunk;
    });
    // Child diagnostics can contain private paths. Drain without displaying them.
    child.stderr.resume();
    child.once("error", () => done("Decision assistance could not start"));
    child.once("close", code => done(code === 0 ? null : "Decision assistance failed; check evidence, provider configuration, and availability"));
    child.stdin.on("error", () => done("Decision assistance input could not be sent"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(input);
  });
}

async function runtime(controlRoot, dataDirectory, { platform = process.platform, run = runProcess,
  installation = null, io = fs, validatePath = validateDirectoryPath } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(controlRoot) || !paths.isAbsolute(dataDirectory)) throw new Error("Decision needs absolute runtime paths");
  if (!["win32", "linux"].includes(platform)) throw new Error("Decision assistance requires a bundled Linux or Windows x86_64 runtime");
  const location = platform === "win32" ? wslLocation(dataDirectory) : null;
  let binary = paths.join(controlRoot, "plugin", "hooks", "bin", platform === "win32" && !location ? "windows-x86_64" : "linux-x86_64",
    platform === "win32" && !location ? "decision-hook.exe" : "decision-hook");
  let linuxBinary = null;
  if (location) {
    const cli = installation?.decisionctl;
    if (typeof cli !== "string" || !cli.startsWith("/") || path.posix.normalize(cli) !== cli ||
        path.posix.basename(cli) !== "decisionctl" || /[\r\n\0]/.test(cli)) {
      throw new Error("Run Decision: Repair Integration before using assistance in WSL");
    }
    linuxBinary = path.posix.join(path.posix.dirname(cli), "decision-hook");
    binary = `\\\\wsl.localhost\\${location.distro}${linuxBinary.replaceAll("/", "\\")}`;
  } else if (installation?.decisionctl) {
    binary = paths.join(paths.dirname(installation.decisionctl), platform === "win32" ? "decision-hook.exe" : "decision-hook");
  }
  if (!paths.isAbsolute(binary) || /[\r\n\0]/.test(binary)) throw new Error("Decision installed runtime path is invalid");
  await validatePath(paths.dirname(binary));
  const details = await io.lstat(binary);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("Decision assistance runtime is missing or linked");
  if (!location) return { command: binary, args: [], env: { ...process.env, PLUGIN_DATA: dataDirectory },
    codexCommand: platform === "win32" ? "codex.exe" : "codex", codexPrefix: [], binary, dataDirectory };
  const converted = linuxBinary || (await run("wsl.exe", ["-d", location.distro, "-e", "wslpath", "-u", binary], { timeout: 10_000 })).trim();
  if (!converted.startsWith("/") || /[\r\n\0]/.test(converted) || path.posix.normalize(converted) !== converted) throw new Error("Decision WSL runtime path is invalid");
  return { command: "wsl.exe", args: ["-d", location.distro, "-e", "env", `PLUGIN_DATA=${location.filename}`, converted],
    env: process.env, codexCommand: "wsl.exe", codexPrefix: ["-d", location.distro, "-e", "codex"],
    binary: converted, dataDirectory: location.filename };
}

async function request(runtime, payload, { flag = "--assist", signal, run = runProcess } = {}) {
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > 128 * 1024) throw new Error("Decision assistance input exceeded its limit");
  const text = await run(runtime.command, [...runtime.args, flag], { env: runtime.env, input, signal });
  return parseUniqueJson(text);
}

async function registerMcp(runtime, run = runProcess) {
  await run(runtime.codexCommand, [...runtime.codexPrefix, "mcp", "add", "codex-decision",
    "--env", `PLUGIN_DATA=${runtime.dataDirectory}`, "--", runtime.binary, "--mcp"], { timeout: 20_000 });
}

module.exports = { runProcess, runtime, request, registerMcp };
